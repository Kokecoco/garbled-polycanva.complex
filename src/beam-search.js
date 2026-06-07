/**
 * beam-search.js
 * 
 * Shift-JIS バイト候補ストリームを探索し、
 * 最も自然な日本語の復元文字列をビームサーチで探索します。
 */

import { generateCandidatesAt } from './candidate-generator.js';
import { scoreTextHeuristic, scoreTextWithTransformers, isModelLoaded } from './transformer-scorer.js';

/**
 * ビームサーチを実行して復元候補を探索します。
 * 
 * @param {Array<number|string>} flatBytes - バイトおよびプレースホルダーの配列
 * @param {number|{beamWidth?:number, topK?:number}} optionsOrBeamWidth - ビーム幅またはオプション
 * @param {Function} stepCallback - 各ステップの進捗通知コールバック
 * @returns {Promise<Array<{text: string, score: number, history: Array<any>}>>} 復元結果候補リスト
 */
export async function performBeamSearch(flatBytes, optionsOrBeamWidth = 100, stepCallback = () => {}) {
  const options = typeof optionsOrBeamWidth === 'number'
    ? { beamWidth: optionsOrBeamWidth, topK: 20, maxBranchingPerStep: 192, yieldEverySteps: 1, yieldEveryExpansions: 128, rerankConcurrency: 4 }
    : { beamWidth: 100, topK: 20, maxBranchingPerStep: 192, yieldEverySteps: 1, yieldEveryExpansions: 128, rerankConcurrency: 4, ...optionsOrBeamWidth };
  const beamWidth = clampPositiveInt(options.beamWidth, 100, 1, 1000);
  const topK = clampPositiveInt(options.topK, 20, 1, 50);
  const maxBranchingPerStep = clampPositiveInt(options.maxBranchingPerStep, 192, 8, 256);
  const yieldEverySteps = clampPositiveInt(options.yieldEverySteps, 1, 1, 16);
  const yieldEveryExpansions = clampPositiveInt(options.yieldEveryExpansions, 128, 32, 4096);
  const rerankConcurrency = clampPositiveInt(options.rerankConcurrency, 4, 1, 8);

  const len = flatBytes.length;
  if (len === 0) return [];

  const candidateCache = new Map();
  const heuristicScoreCache = new Map();

  // 初期状態
  let beam = [{
    byteIndex: 0,
    text: '',
    score: 0.0,
    heuristicScore: 0.0,
    historyNode: null
  }];

  const completedStates = [];

  // 最大ステップ数（無限ループ防止のため、バイト数の2倍を上限とする）
  const maxSteps = len * 2;
  let step = 0;

  let expansionsSinceYield = 0;
  while (beam.length > 0 && step < maxSteps) {
    const nextStatesPool = [];
    let allCompleted = true;

    for (const state of beam) {
      // 終端に達した状態
      if (state.byteIndex >= len) {
        completedStates.push(state);
        continue;
      }

      allCompleted = false;

      // 現在のインデックスから生成可能な次の文字候補を取得
      let candidates = candidateCache.get(state.byteIndex);
      if (!candidates) {
        const generated = generateCandidatesAt(flatBytes, state.byteIndex);
        candidates = limitCandidates(generated, maxBranchingPerStep);
        candidateCache.set(state.byteIndex, candidates);
      }

      if (candidates.length === 0) {
        // デッドエンド（パース失敗）：少し戻ってスキップするか、スコアを大幅に下げて完了とする
        // ここでは、1バイトスキップして進む遷移を強制的に追加し、デッドエンドを回避します。
        nextStatesPool.push({
          byteIndex: state.byteIndex + 1,
          text: state.text, // 文字は追加しない
          score: state.score - 5.0, // ペナルティ
          heuristicScore: state.heuristicScore - 5.0,
          historyNode: {
            prev: state.historyNode,
            originalBytes: typeof flatBytes[state.byteIndex] === 'number' 
              ? flatBytes[state.byteIndex].toString(16).toUpperCase() 
              : flatBytes[state.byteIndex],
            char: '' // 不正文字マーク
          }
        });
        continue;
      }

      for (const cand of candidates) {
        const nextText = state.text + cand.char;
        const nextByteIndex = state.byteIndex + cand.bytesConsumed;

        // 元のバイト列表記を作成 (履歴用)
        const originalBytesSlice = flatBytes.slice(state.byteIndex, nextByteIndex);
        const originalBytesStr = originalBytesSlice
          .map(b => typeof b === 'number' ? b.toString(16).padStart(2, '0').toUpperCase() : b)
          .join(' ');

        // 高速なヒューリスティックスコアを算出
        let textScore = heuristicScoreCache.get(nextText);
        if (textScore === undefined) {
          textScore = scoreTextHeuristic(nextText);
          heuristicScoreCache.set(nextText, textScore);
        }
        
        // 曖昧性のある復元の場合はスコアを微調整（文字数あたりのペナルティなど）
        const ambiguityPenalty = cand.isAmbiguous ? -0.1 : 0.0;

        nextStatesPool.push({
          byteIndex: nextByteIndex,
          text: nextText,
          score: textScore + ambiguityPenalty,
          heuristicScore: textScore + ambiguityPenalty,
          historyNode: {
            prev: state.historyNode,
            originalBytes: originalBytesStr,
            char: cand.char || '(無視)'
          }
        });

        expansionsSinceYield++;
        if (expansionsSinceYield >= yieldEveryExpansions) {
          expansionsSinceYield = 0;
          await yieldToEventLoop();
        }
      }
    }

    if (allCompleted) {
      break;
    }

    // 重複した文を持つ状態をマージ（同じテキストならバイトインデックスが進んでいる方を優先）
    const mergedPool = [];
    const seenTexts = new Map();
    for (const s of nextStatesPool) {
      if (!seenTexts.has(s.text) || seenTexts.get(s.text).byteIndex < s.byteIndex) {
        seenTexts.set(s.text, s);
      }
    }
    for (const s of seenTexts.values()) {
      mergedPool.push(s);
    }

    // スコアの高い順にソートし、ビーム幅にカット
    mergedPool.sort((a, b) => b.score - a.score);
    beam = mergedPool.slice(0, beamWidth);

    step++;
    stepCallback(Math.min(0.9, (step / len))); // 進捗率通知 (MAX 90%)
    if (step % yieldEverySteps === 0) {
      await yieldToEventLoop();
    }
  }

  // 途中で完了しなかったビーム内の残存状態もマージ
  const allCandidates = [...completedStates, ...beam];

  // 重複候補の排除
  const uniqueResultsMap = new Map();
  for (const s of allCandidates) {
    // スコアの高い方を残す
    if (!uniqueResultsMap.has(s.text) || uniqueResultsMap.get(s.text).score < s.score) {
      uniqueResultsMap.set(s.text, s);
    }
  }

  let finalCandidates = Array.from(uniqueResultsMap.values());

  // 1次ソート (ヒューリスティックスコアに基づく)
  finalCandidates.sort((a, b) => b.score - a.score);

  // 上位20件程度に絞り込む
  finalCandidates = finalCandidates.slice(0, topK);

  stepCallback(0.95); // 並び替えフェーズへ

  // Transformers.js モデルがロードされている場合、上位候補をBERTで再スコアリング (Reranking)
  if (isModelLoaded()) {
    console.log('Reranking candidates using Transformers.js...');
    finalCandidates = await mapWithConcurrency(finalCandidates, rerankConcurrency, async (cand) => {
      const transformerScore = await scoreTextWithTransformers(cand.text);
      return {
        ...cand,
        lmScore: transformerScore,
        score: transformerScore // Transformersのスコアで上書き
      };
    });
    finalCandidates.sort((a, b) => b.score - a.score);
  }

  stepCallback(1.0); // 完了

  return finalCandidates.map(c => ({
    text: c.text,
    score: c.score,
    heuristicScore: c.heuristicScore,
    lmScore: c.lmScore ?? null,
    history: historyNodeToArray(c.historyNode)
  }));
}

function limitCandidates(candidates, maxBranchingPerStep) {
  if (candidates.length <= maxBranchingPerStep) {
    return candidates;
  }
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      prior: getCandidatePrior(candidate)
    }))
    .sort((a, b) => b.prior - a.prior)
    .slice(0, maxBranchingPerStep)
    .map(({ candidate }) => candidate);

  return ranked;
}

function getCandidatePrior(candidate) {
  const char = candidate.char;
  if (!char) return -2.0;

  const code = char.charCodeAt(0);
  let score = candidate.isAmbiguous ? 0 : 0.4;

  // ひらがな
  if (code >= 0x3040 && code <= 0x309F) score += 2.2;
  // カタカナ
  else if (code >= 0x30A0 && code <= 0x30FF) score += 1.9;
  // 漢字
  else if (code >= 0x4E00 && code <= 0x9FFF) score += 1.6;
  // ASCII英数字
  else if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) score += 1.0;
  // ASCII記号
  else if (code >= 0x20 && code <= 0x7E) score += 0.2;
  else score -= 1.0;

  return score;
}

function historyNodeToArray(node) {
  const history = [];
  let current = node;
  while (current) {
    history.push({
      originalBytes: current.originalBytes,
      char: current.char
    });
    current = current.prev;
  }
  history.reverse();
  return history;
}

function clampPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor++;
      if (index >= items.length) break;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
