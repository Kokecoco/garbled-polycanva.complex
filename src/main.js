/**
 * main.js
 * 
 * アプリケーションのメインコントローラー。
 * ユーザー入力、イベント処理、UI更新、モデルのロードおよびビームサーチ復元処理を統合します。
 */

import { textToSjisBytes } from './utf8-recovery.js';
import { generateCandidateSets } from './candidate-generator.js';
import { performBeamSearch } from './beam-search.js';
import { loadScoringModel, isModelLoaded } from './transformer-scorer.js';

// DOM 要素の取得
const inputText = document.getElementById('input-text');
const beamWidthInput = document.getElementById('beam-width');
const candidateLimitInput = document.getElementById('candidate-limit');
const debugModeInput = document.getElementById('debug-mode');
const btnLoadModel = document.getElementById('btn-load-model');
const modelStatus = document.getElementById('model-status');
const modelProgressContainer = document.getElementById('model-progress-container');
const modelProgressFill = document.getElementById('model-progress-fill');
const modelProgressText = document.getElementById('model-progress-text');
const btnRecover = document.getElementById('btn-recover');
const recoveryProgressContainer = document.getElementById('recovery-progress-container');
const recoveryProgressFill = document.getElementById('recovery-progress-fill');
const recoveryProgressText = document.getElementById('recovery-progress-text');
const resultsSection = document.getElementById('results-section');
const resultsCount = document.getElementById('results-count');
const bestResultCard = document.getElementById('best-result-card');
const resultsList = document.getElementById('results-list');
const debugSection = document.getElementById('debug-section');
const debugOutput = document.getElementById('debug-output');

// イベントリスナーの登録
btnLoadModel.addEventListener('click', handleLoadModel);
btnRecover.addEventListener('click', handleRecover);

// サンプル文字化けテキストの初期ロード (未入力の場合)
if (!inputText.value) {
  inputText.value = '縺薙ｓ縺ｫ縺｡縺ｯ'; // 「こんにちは」
}

/**
 * AIモデルの非同期ロードを処理します。
 */
async function handleLoadModel() {
  if (isModelLoaded()) return;

  btnLoadModel.disabled = true;
  modelStatus.textContent = 'ロード中...';
  modelStatus.className = 'status-badge status-loading';
  modelProgressContainer.classList.remove('hidden');

  try {
    await loadScoringModel((progress) => {
      const percentage = Math.round(progress * 100);
      modelProgressFill.style.width = `${percentage}%`;
      modelProgressText.textContent = `${percentage}%`;
    });

    modelStatus.textContent = 'AIモデル有効';
    modelStatus.className = 'status-badge status-loaded';
    btnLoadModel.textContent = '🤖 モデルロード完了';
    
    // ロード成功から2秒後にプログレスバーをフェードアウト
    setTimeout(() => {
      modelProgressContainer.classList.add('hidden');
    }, 2000);
  } catch (error) {
    modelStatus.textContent = 'ロード失敗（高速モード動作）';
    modelStatus.className = 'status-badge status-unloaded';
    btnLoadModel.disabled = false;
    btnLoadModel.textContent = '⚠️ リトライ';
    alert('モデルのダウンロード中にエラーが発生しました。ネットワーク接続を確認してください。引き続き高速モード（高速統計モデル）での復元は可能です。');
  }
}

/**
 * 文字化け復元の実行ボタン処理。
 */
async function handleRecover() {
  const text = inputText.value.trim();
  if (!text) {
    alert('文字化けテキストを入力してください。');
    return;
  }

  const beamWidth = parseInt(beamWidthInput.value, 10) || 100;
  const candidateLimit = parseInt(candidateLimitInput.value, 10) || 5;
  const debugMode = debugModeInput.checked;

  // UI状態の初期化
  btnRecover.disabled = true;
  recoveryProgressContainer.classList.remove('hidden');
  recoveryProgressFill.style.width = '0%';
  recoveryProgressText.textContent = '0%';
  resultsSection.classList.add('hidden');

  try {
    // 1. Shift-JISバイト列へのデコード（文字化け文字列から元のUTF-8推定バイト列へ）
    const sjisBytes = textToSjisBytes(text);
    console.log('SJIS Bytes extracted:', sjisBytes);
    const candidateSets = debugMode ? generateCandidateSets(sjisBytes) : [];

    // 2. ビームサーチ探索の実行
    const candidates = await performBeamSearch(
      sjisBytes,
      { beamWidth, topK: Math.max(candidateLimit * 4, 20) },
      (progress) => {
      const percentage = Math.round(progress * 100);
      recoveryProgressFill.style.width = `${percentage}%`;
      recoveryProgressText.textContent = `${percentage}%`;
      }
    );

    // 3. 結果の表示
    renderResults(candidates.slice(0, candidateLimit), {
      candidateSets,
      debugMode,
      beamWidth,
      usedModel: isModelLoaded()
    });
  } catch (error) {
    console.error('Recovery process failed:', error);
    alert('復元処理中にエラーが発生しました: ' + error.message);
  } finally {
    btnRecover.disabled = false;
    // 処理完了から少し経って進行状況バーを隠す
    setTimeout(() => {
      recoveryProgressContainer.classList.add('hidden');
    }, 500);
  }
}

/**
 * 復元結果リストを画面にレンダリングします。
 */
function renderResults(candidates, options = {}) {
  const { candidateSets = [], debugMode = false, beamWidth = 100, usedModel = false } = options;
  resultsList.innerHTML = '';
  resultsCount.textContent = `${candidates.length}件の候補`;
  debugOutput.textContent = '';
  debugSection.classList.add('hidden');
  bestResultCard.innerHTML = '';

  if (candidates.length === 0) {
    resultsList.innerHTML = '<div class="result-item"><div class="result-text">復元候補が見つかりませんでした。文字コードの境界が不整合、または欠損が激しすぎます。</div></div>';
    resultsSection.classList.remove('hidden');
    return;
  }

  const best = candidates[0];
  const confidence = calculateConfidence(candidates);
  bestResultCard.innerHTML = `
    <div class="best-label">Most Likely Reconstruction</div>
    <div class="best-text">${escapeHtml(best.text)}</div>
    <div class="best-meta">
      <span class="badge">Confidence: ${confidence}%</span>
      <span class="badge">${usedModel ? 'Transformer Ranking' : 'Heuristic Ranking'}</span>
    </div>
  `;

  candidates.forEach((cand, idx) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    
    // スコアの正規化表記
    const normalizedScore = cand.score.toFixed(2);

    // 候補生成の根拠 (バイト -> 文字の対応フロー)
    let evidenceHTML = '';
    if (cand.history && cand.history.length > 0) {
      const tokensHTML = cand.history.map(h => `
        <div class="evidence-token">
          <span class="token-original">${h.originalBytes || '??'}</span>
          <span class="token-restored">${escapeHtml(h.char) || '∅'}</span>
        </div>
      `).join('');
      
      evidenceHTML = `
        <div class="evidence-section">
          <div class="evidence-title">復元根拠 (Shift-JISバイト ➔ 復元文字)</div>
          <div class="evidence-flow">${tokensHTML}</div>
        </div>
      `;
    }

    item.innerHTML = `
      <div class="result-main-row">
        <div class="result-text">${escapeHtml(cand.text)}</div>
        <div class="result-meta">
          <span class="score-badge">${idx === 0 ? '👑 Best' : `${idx + 1}. Alternative`}</span>
          <span class="score-badge">Score: ${normalizedScore}</span>
          <button type="button" class="btn-copy" title="クリップボードにコピー">📋</button>
        </div>
      </div>
      ${evidenceHTML}
    `;

    // コピーボタンのロジック
    const btnCopy = item.querySelector('.btn-copy');
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(cand.text).then(() => {
        btnCopy.textContent = '✅';
        btnCopy.title = 'コピー完了！';
        setTimeout(() => {
          btnCopy.textContent = '📋';
          btnCopy.title = 'クリップボードにコピー';
        }, 1500);
      }).catch(err => {
        console.error('Copy failed:', err);
      });
    });

    resultsList.appendChild(item);
  });

  if (debugMode) {
    const debugData = {
      beamWidth,
      candidateSets,
      beamResults: candidates.map((cand, idx) => ({
        rank: idx + 1,
        text: cand.text,
        finalScore: cand.score,
        heuristicScore: cand.heuristicScore,
        languageModelScore: cand.lmScore
      }))
    };
    debugOutput.textContent = JSON.stringify(debugData, null, 2);
    debugSection.classList.remove('hidden');
  }

  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function calculateConfidence(candidates) {
  if (candidates.length === 1) return 100;
  const topScore = candidates[0].score;
  const secondScore = candidates[1].score;
  const topExp = Math.exp(topScore);
  const secondExp = Math.exp(secondScore);
  return Math.max(1, Math.min(100, Math.round((topExp / (topExp + secondExp)) * 100)));
}

/**
 * HTMLのエスケープ処理
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
