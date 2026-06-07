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
    ? { beamWidth: optionsOrBeamWidth, topK: 20 }
    : { beamWidth: 100, topK: 20, ...optionsOrBeamWidth };
  const beamWidth = options.beamWidth;
  const topK = options.topK;

  const len = flatBytes.length;
  if (len === 0) return [];

  // 初期状態
  let beam = [{
    byteIndex: 0,
    text: '',
    score: 0.0,
    heuristicScore: 0.0,
    history: [] // 復元の根拠履歴: { originalBytes: string, char: string }
  }];

  const completedStates = [];

  // 最大ステップ数（無限ループ防止のため、バイト数の2倍を上限とする）
  const maxSteps = len * 2;
  let step = 0;

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
      const candidates = generateCandidatesAt(flatBytes, state.byteIndex);

      if (candidates.length === 0) {
        // デッドエンド（パース失敗）：少し戻ってスキップするか、スコアを大幅に下げて完了とする
        // ここでは、1バイトスキップして進む遷移を強制的に追加し、デッドエンドを回避します。
        nextStatesPool.push({
          byteIndex: state.byteIndex + 1,
          text: state.text, // 文字は追加しない
          score: state.score - 5.0, // ペナルティ
          heuristicScore: state.heuristicScore - 5.0,
          history: state.history.concat({
            originalBytes: typeof flatBytes[state.byteIndex] === 'number' 
              ? flatBytes[state.byteIndex].toString(16).toUpperCase() 
              : flatBytes[state.byteIndex],
            char: '' // 不正文字マーク
          })
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
        const textScore = scoreTextHeuristic(nextText);
        
        // 曖昧性のある復元の場合はスコアを微調整（文字数あたりのペナルティなど）
        const ambiguityPenalty = cand.isAmbiguous ? -0.1 : 0.0;

        nextStatesPool.push({
          byteIndex: nextByteIndex,
          text: nextText,
          score: textScore + ambiguityPenalty,
          heuristicScore: textScore + ambiguityPenalty,
          history: state.history.concat({
            originalBytes: originalBytesStr,
            char: cand.char || '(無視)'
          })
        });
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
    const reranked = [];
    for (const cand of finalCandidates) {
      const transformerScore = await scoreTextWithTransformers(cand.text);
      reranked.push({
        ...cand,
        lmScore: transformerScore,
        score: transformerScore // Transformersのスコアで上書き
      });
    }
    reranked.sort((a, b) => b.score - a.score);
    finalCandidates = reranked;
  }

  stepCallback(1.0); // 完了

  return finalCandidates.map(c => ({
    text: c.text,
    score: c.score,
    heuristicScore: c.heuristicScore,
    lmScore: c.lmScore ?? null,
    history: c.history
  }));
}
