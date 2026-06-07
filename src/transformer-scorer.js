/**
 * transformer-scorer.js
 * 
 * 候補文の日本語としての「自然さ」をスコアリングします。
 * Transformers.js (BERT/RoBERTa 等の多言語/日本語モデル) による高精度スコアリングと、
 * ダウンロード不要・超高速で動作する「日本語文字遷移統計 (bi-gram)」によるヒューリスティックスコアリングをサポートします。
 */

import { env, pipeline } from '@huggingface/transformers';

// Transformers.js の環境設定（ブラウザ環境で動作するように設定）
env.allowLocalModels = false;

let fillMaskPipeline = null;
let modelLoading = false;
let modelLoaded = false;

// 日本語の頻出 2-gram ペアとそのスコア（正のスコア = 日本語として自然、負のスコア = 不自然）
const JAPANESE_BIGRAMS = {
  'する': 5.0, 'して': 4.5, 'した': 4.0, 'です': 4.5, 'ます': 4.5, 'あり': 3.5, 'ある': 3.5,
  'こと': 4.0, 'もの': 3.5, 'とき': 3.5, 'よう': 3.5, 'これ': 3.0, 'それ': 3.0, 'その': 3.0,
  'この': 3.0, 'ため': 3.0, 'から': 3.0, 'ので': 3.0, 'ない': 3.5, 'など': 3.0, 'てい': 3.5,
  'にお': 2.5, 'にお': 2.5, 'うご': 2.5, 'れば': 3.0, 'たら': 3.0, 'でも': 3.0, 'てす': -2.0, // 「てす」より「です」
  'まし': 3.5, 'しょ': 2.5, 'ちっ': 2.0, 'しょ': 2.5, 'じゃ': 2.5, 'おう': 2.5, 'こう': 2.5,
  'そう': 2.5, 'とう': 2.5, 'きょ': 2.5, 'しょ': 2.5, 'ちょ': 2.5, 'りょ': 2.5, 'ひら': 2.0,
  'かな': 2.0, '漢字': 3.0, '文字': 3.0, '化け': 3.0, '復元': 3.0, 'こん': 3.5, 'んに': 3.5,
  'にち': 3.5, 'ちは': 3.5 // 「こんにちは」の遷移をカバー
};

// 助詞の後に来やすい・来にくい文字種パターン
const JOSHI = ['は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'の', 'て', 'に'];

// カタカナ語として自然な語彙（スコア加点用）
const COMMON_KATAKANA_WORDS = [
  'テキスト', 'システム', 'データ', 'モデル', 'コンテキスト', 'トランスフォーマー',
  'アプリ', 'サービス', 'サンプル', 'ブラウザ', 'コード'
];

// 常用漢字（高スコア）/ 人名用漢字（中スコア）の抜粋セット
// ※ 全件ではなく、文書で頻出しやすい文字を優先した軽量テーブル
const JOYO_KANJI_SET = new Set('一右雨円王音下火花貝学気九休玉金空月犬見五口校左三山子四糸字耳七車手十出女小上森人水正生青夕石赤千川先早草足村大男竹中虫町天田土二日入年白八百文本名木目立力林六話私新語復元文字化例常用漢字第一第二水準');
const JINMEIYO_KANJI_SET = new Set('亜尉逸詠瑛旺桜叶莞岬峻惺惟慧柊颯凪遥凜玲');

// 日本語文脈で出現頻度の低い記号（文字化け残りで混入しやすい）
const RARE_SYMBOL_SET = new Set(['〮', '〯', '゠']);

/**
 * 日本語の文字種（ひらがな、カタカナ、漢字、ASCII）を判定します。
 */
function getCharType(char) {
  const code = char.charCodeAt(0);
  if (code >= 0x3040 && code <= 0x309F) return 'hiragana';
  if (code >= 0x30A0 && code <= 0x30FF) return 'katakana';
  if (code >= 0x4E00 && code <= 0x9FFF) return 'kanji';
  if (code >= 0x0020 && code <= 0x007E) return 'ascii';
  return 'other';
}

/**
 * Transformers.js の言語モデルをロードします。
 * @param {Function} progressCallback - ロードの進捗状況（0.0〜1.0）を受け取るコールバック
 */
export async function loadScoringModel(progressCallback = () => {}) {
  if (modelLoaded) return true;
  if (modelLoading) return false;

  modelLoading = true;
  try {
    // 日本語も解釈できる軽量な多言語モデル (約270MBですが、ブラウザでキャッシュされます)
    const modelName = 'Xenova/bert-base-multilingual-cased';
    
    fillMaskPipeline = await pipeline('fill-mask', modelName, {
      progress_callback: (data) => {
        if (data.status === 'progress') {
          progressCallback(data.progress / 100);
        } else if (data.status === 'ready') {
          progressCallback(1.0);
        }
      }
    });

    modelLoaded = true;
    modelLoading = false;
    return true;
  } catch (error) {
    console.error('Failed to load Transformers model:', error);
    modelLoading = false;
    throw error;
  }
}

/**
 * モデルがロード済みかチェックします。
 */
export function isModelLoaded() {
  return modelLoaded;
}

/**
 * ヒューリスティックに基づき、文の「日本語らしさ」のスコアを計算します。
 * （ビームサーチ時の高速評価およびオフライン時のフォールバックに使用）
 * 
 * @param {string} text 
 * @returns {number} スコア（高いほど自然）
 */
export function scoreTextHeuristic(text) {
  if (!text || text.length === 0) return -100;

  let score = 0;
  let hiraganaCount = 0;
  let katakanaCount = 0;
  let kanjiCount = 0;
  let otherCount = 0;

  // 1. 文字種比率による評価
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const type = getCharType(char);
    if (type === 'hiragana') hiraganaCount++;
    else if (type === 'katakana') katakanaCount++;
    else if (type === 'kanji') kanjiCount++;
    else otherCount++;

    // 常用漢字/人名漢字/表外漢字の重みづけ
    if (type === 'kanji') {
      if (JOYO_KANJI_SET.has(char)) {
        score += 1.2;
      } else if (JINMEIYO_KANJI_SET.has(char)) {
        score += 0.3;
      } else {
        // BMP内の表外漢字（JIS第一/第二水準の表外や希少字）を低スコア
        score -= 1.5;
      }
    }

    // 文中に滅多に使われない特殊な記号や文字（文字化けが残っている部分）があれば強いペナルティ
    if (type === 'other') {
      const code = char.charCodeAt(0);
      // CJK記号（読点など）以外の珍しい文字
      if (!(code >= 0x3000 && code <= 0x303F) && !(code >= 0xFF00 && code <= 0xFFEF)) {
        score -= 10.0;
      }
    }

    if (RARE_SYMBOL_SET.has(char)) {
      score -= 4.0;
    }
  }

  const total = text.length;
  // 一般的な日本語文章のバランス（ひらがな・漢字がメインで、カタカナが少し）
  // ひらがなが多めの文章は自然であることが多い
  const hiraganaRatio = hiraganaCount / total;
  const kanjiRatio = kanjiCount / total;
  const otherRatio = otherCount / total;

  // ひらがなが極端に少ない、または記号が極端に多い場合はペナルティ
  if (hiraganaRatio < 0.1 && total > 5) score -= 15.0;
  if (otherRatio > 0.4) score -= 20.0;

  // 2. bi-gram（文字遷移）の評価
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.substr(i, 2);
    
    // 頻出 bi-gram が含まれる場合はボーナス
    if (JAPANESE_BIGRAMS[pair] !== undefined) {
      score += JAPANESE_BIGRAMS[pair];
    }

    // 4. 一般語彙として成立する語のボーナス（例: テキスト）
    for (const word of COMMON_KATAKANA_WORDS) {
      if (text.includes(word)) {
        score += 4.0;
      }
    }

    // 不自然なカタカナ接続（例: ダキスト）へのペナルティ
    if (text.includes('ダキ')) {
      score -= 3.0;
    }

    const type1 = getCharType(pair[0]);
    const type2 = getCharType(pair[1]);

    // ひらがな -> ひらがな、漢字 -> ひらがな は非常に自然
    if (type1 === 'hiragana' && type2 === 'hiragana') score += 0.8;
    if (type1 === 'kanji' && type2 === 'hiragana') score += 1.2; // 送り仮名のパターン

    // カタカナ -> ひらがな の直接遷移は少し不自然（例：「カな」などの文字化け残り）
    if (type1 === 'katakana' && type2 === 'hiragana') score -= 1.0;
    
    // 助詞の連続は不自然
    if (JOSHI.includes(pair[0]) && JOSHI.includes(pair[1])) {
      score -= 3.0;
    }
  }

  // 3. 文末の評価（日本語は「〜する」「〜した」「〜です」「〜ます」や句点で終わることが多い）
  if (text.length > 2) {
    const end1 = text[text.length - 1];
    const end2 = text.substr(text.length - 2, 2);
    const end3 = text.substr(text.length - 3, 3);

    if (end1 === '。' || end1 === '.' || end1 === '！' || end1 === '？') {
      score += 2.0;
    }
    if (end2 === 'です' || end2 === 'ます' || end2 === 'した' || end2 === 'する' || end2 === 'ない' || end2 === 'れた') {
      score += 4.0;
    }
    if (end3 === 'でした' || end3 === 'ました' || end3 === 'ていた') {
      score += 5.0;
    }
  }

  // 長さに対する正規化（短い文と長い文の公平な比較のため）
  return score / total;
}

/**
 * Transformers.js (BERT) を使用して、候補文の尤度（自然さ）を評価します。
 * @param {string} text 
 * @returns {Promise<number>} 対数尤度スコア
 */
export async function scoreTextWithTransformers(text) {
  if (!fillMaskPipeline) {
    return scoreTextHeuristic(text);
  }

  try {
    // 文が短すぎる場合はヒューリスティックのみで評価
    if (text.length <= 1) return -5.0;

    // 文全体の自然さを評価するため、文の途中のいくつかの文字を [MASK] に置き換え、
    // その位置に本来の文字が入る確率（予測確率）を計算します。
    // 計算負荷を下げるため、最大3箇所をランダム（または等間隔）にマスクして検証します。
    let logProbSum = 0;
    const maskPositions = selectMaskPositions(text);
    let maskCount = 0;

    for (const i of maskPositions) {
      const originalChar = text[i];
      // マスク対象がスペースや記号の場合はスキップ
      if (getCharType(originalChar) === 'other' && (originalChar === ' ' || originalChar === '　')) {
        continue;
      }

      // [MASK] に置き換えたテキストを作成
      const maskedText = text.substring(0, i) + '[MASK]' + text.substring(i + 1);
      
      // 推論実行
      const results = await fillMaskPipeline(maskedText, {
        topk: 10,
        targets: [originalChar] // 本来の文字のみのスコアを要求
      });

      // results はターゲットが見つかった場合のスコア配列、または見つからない場合は空
      if (results && results.length > 0) {
        const score = results[0].score; // 0.0〜1.0 の確率
        logProbSum += Math.log(score + 1e-5); // 安全な対数変換
      } else {
        logProbSum += Math.log(1e-5); // ターゲットが含まれなかった場合の最低スコア
      }
      maskCount++;
    }

    if (maskCount === 0) {
      return scoreTextHeuristic(text);
    }

    /**
     * 文脈判定のためにマスクする位置を選択します。
     * 語頭/語尾、カタカナ語、漢字など意味に寄与しやすい位置を優先します。
     */
    function selectMaskPositions(text) {
      const positions = new Set();
      const maxMasks = Math.min(8, Math.max(3, Math.ceil(text.length / 4)));

      // 均等サンプリング
      const interval = Math.max(1, Math.floor(text.length / maxMasks));
      for (let i = 1; i < text.length - 1; i += interval) {
        positions.add(i);
      }

      // 文末/語尾の評価を取りこぼさない
      if (text.length > 2) positions.add(text.length - 2);

      // カタカナ・漢字・その他記号を優先評価
      for (let i = 1; i < text.length - 1; i++) {
        const type = getCharType(text[i]);
        if (type === 'katakana' || type === 'kanji' || type === 'other') {
          positions.add(i);
        }
      }

      return Array.from(positions).sort((a, b) => a - b).slice(0, maxMasks);
    }

    // 平均対数確率にヒューリスティックスコアをハイブリッドで少し加味
    const bertScore = logProbSum / maskCount;
    const heuristicScore = scoreTextHeuristic(text);
    
    return bertScore * 0.7 + heuristicScore * 0.3;
  } catch (error) {
    console.error('Transformers scoring failed, falling back to heuristic:', error);
    return scoreTextHeuristic(text);
  }
}
