/**
 * candidate-generator.js
 * 
 * Shift-JISバイト列（一部不確定バイトを含む）から、
 * UTF-8としての文脈および日本語の文字範囲の制約を用いて、
 * 各位置で発生し得る妥当な文字候補を生成します。
 */

import { decodeUtf8Safe } from './utf8-recovery.js';

// 日本語および一般的なテキスト文字として妥当なUnicode範囲を定義
const VALID_RANGES = [
  [0x0020, 0x007E], // ASCII（印刷可能文字）
  [0x3000, 0x303F], // CJK記号・句読点
  [0x3040, 0x309F], // ひらがな
  [0x30A0, 0x30FF], // カタカナ
  [0x4E00, 0x9FFF], // CJK統合漢字 (主要漢字)
  [0xFF00, 0xFFEF]  // 半角・全角形（全角英数、半角カナ等）
];

/**
 * 文字が日本語および一般的なテキストとして妥当な文字コード範囲に収まっているか判定します。
 * @param {string} char 
 * @returns {boolean}
 */
export function isValidJapaneseChar(char) {
  if (!char || char.length === 0) return false;
  const code = char.charCodeAt(0);
  for (const [start, end] of VALID_RANGES) {
    if (code >= start && code <= end) {
      return true;
    }
  }
  return false;
}

/**
 * 指定されたバイト位置から、UTF-8としてデコード可能な文字候補と、
 * その際に消費したバイト数を生成します。
 * 
 * @param {Array<number|string>} flatBytes - バイト配列。数値（0x00-0xFF）または 'UNK'（不明）
 * @param {number} index - 開始インデックス
 * @returns {Array<{char: string, bytesConsumed: number, isAmbiguous: boolean}>} 候補リスト
 */
export function generateCandidatesAt(flatBytes, index) {
  const candidates = [];
  const len = flatBytes.length;

  if (index >= len) return candidates;

  // 1. スキップ遷移の考慮 (文字化けで破損し、無視すべきバイトがあった場合のためのフォールバック)
  // もし現在のバイトが 'UNK' の場合、0バイト消費（スキップ）して次に進む選択肢を与える
  if (flatBytes[index] === 'UNK') {
    candidates.push({
      char: '', // 文字は生成しない
      bytesConsumed: 1, // 'UNK' トークンを1つ消費
      isAmbiguous: true
    });
  }

  // --- UTF-8 のデコード規則に沿った検証 ---

  // 1バイト文字 (ASCII: 0x00-0x7F)
  const b1 = flatBytes[index];
  if (b1 === 'UNK') {
    // UNK の場合、1バイト文字として ASCII 印字可能文字を候補に加える
    for (let code = 0x20; code <= 0x7E; code++) {
      const char = String.fromCharCode(code);
      candidates.push({ char, bytesConsumed: 1, isAmbiguous: true });
    }
  } else if (b1 >= 0x00 && b1 <= 0x7F) {
    const char = String.fromCharCode(b1);
    candidates.push({ char, bytesConsumed: 1, isAmbiguous: false });
  }

  // 2バイト文字 (0xC2-0xDF)
  if (index + 1 < len) {
    const b2 = flatBytes[index + 1];
    
    // b1が 0xC2-0xDF または UNK、b2が 0x80-0xBF または UNK
    const isB1Valid = (b1 === 'UNK' || (b1 >= 0xC2 && b1 <= 0xDF));
    const isB2Valid = (b2 === 'UNK' || (b2 >= 0x80 && b2 <= 0xBF));

    if (isB1Valid && isB2Valid) {
      const b1List = b1 === 'UNK' ? range(0xC2, 0xDF) : [b1];
      const b2List = b2 === 'UNK' ? range(0x80, 0xBF) : [b2];
      const isAmbiguous = (b1 === 'UNK' || b2 === 'UNK');

      for (const val1 of b1List) {
        for (const val2 of b2List) {
          const char = decodeUtf8Safe([val1, val2]);
          if (char && isValidJapaneseChar(char)) {
            candidates.push({ char, bytesConsumed: 2, isAmbiguous });
          }
        }
      }
    }
  }

  // 3バイト文字 (0xE0-0xEF) - 日本語文字のメインストリーム
  if (index + 2 < len) {
    const b2 = flatBytes[index + 1];
    const b3 = flatBytes[index + 2];

    const isB1Valid = (b1 === 'UNK' || (b1 >= 0xE0 && b1 <= 0xEF));
    const isB2Valid = (b2 === 'UNK' || (b2 >= 0x80 && b2 <= 0xBF));
    const isB3Valid = (b3 === 'UNK' || (b3 >= 0x80 && b3 <= 0xBF));

    if (isB1Valid && isB2Valid && isB3Valid) {
      // 探索範囲の最適化 (日本語文字が最も多く含まれる 0xE3-0xE9 付近を優先的に、必要に応じて全域を探索)
      const b1List = b1 === 'UNK' ? range(0xE0, 0xEF) : [b1];
      const b2List = b2 === 'UNK' ? range(0x80, 0xBF) : [b2];
      const b3List = b3 === 'UNK' ? range(0x80, 0xBF) : [b3];
      const isAmbiguous = (b1 === 'UNK' || b2 === 'UNK' || b3 === 'UNK');

      for (const val1 of b1List) {
        // UTF-8 の特定開始バイトごとの第2バイト制約
        let currentB2List = b2List;
        if (val1 === 0xE0) {
          currentB2List = b2List.filter(v => v >= 0xA0);
        } else if (val1 === 0xED) {
          currentB2List = b2List.filter(v => v <= 0x9F);
        }

        for (const val2 of currentB2List) {
          for (const val3 of b3List) {
            const char = decodeUtf8Safe([val1, val2, val3]);
            if (char && isValidJapaneseChar(char)) {
              candidates.push({ char, bytesConsumed: 3, isAmbiguous });
            }
          }
        }
      }
    }
  }

  // 4バイト文字 (0xF0-0xF4)
  if (index + 3 < len) {
    const b2 = flatBytes[index + 1];
    const b3 = flatBytes[index + 2];
    const b4 = flatBytes[index + 3];

    const isB1Valid = (b1 === 'UNK' || (b1 >= 0xF0 && b1 <= 0xF4));
    const isB2Valid = (b2 === 'UNK' || (b2 >= 0x80 && b2 <= 0xBF));
    const isB3Valid = (b3 === 'UNK' || (b3 >= 0x80 && b3 <= 0xBF));
    const isB4Valid = (b4 === 'UNK' || (b4 >= 0x80 && b4 <= 0xBF));

    if (isB1Valid && isB2Valid && isB3Valid && isB4Valid) {
      const b1List = b1 === 'UNK' ? range(0xF0, 0xF4) : [b1];
      const b2List = b2 === 'UNK' ? range(0x80, 0xBF) : [b2];
      const b3List = b3 === 'UNK' ? range(0x80, 0xBF) : [b3];
      const b4List = b4 === 'UNK' ? range(0x80, 0xBF) : [b4];
      const isAmbiguous = (b1 === 'UNK' || b2 === 'UNK' || b3 === 'UNK' || b4 === 'UNK');

      for (const val1 of b1List) {
        let currentB2List = b2List;
        if (val1 === 0xF0) {
          currentB2List = b2List.filter(v => v >= 0x90);
        } else if (val1 === 0xF4) {
          currentB2List = b2List.filter(v => v <= 0x8F);
        }

        for (const val2 of currentB2List) {
          for (const val3 of b3List) {
            for (const val4 of b4List) {
              const char = decodeUtf8Safe([val1, val2, val3, val4]);
              if (char && isValidJapaneseChar(char)) {
                candidates.push({ char, bytesConsumed: 4, isAmbiguous });
              }
            }
          }
        }
      }
    }
  }

  // 重複候補を削除 (同じ文字で異なるバイト消費パターンがある場合、消費の大きい方を優先するか、両方残す)
  // ここでは文字と消費バイト数のペアで一意にします。
  const uniqueCandidates = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.char}_${c.bytesConsumed}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCandidates.push(c);
    }
  }

  return uniqueCandidates;
}

/**
 * 範囲 [start, end] の配列を生成します。
 */
function range(start, end) {
  const arr = [];
  for (let i = start; i <= end; i++) {
    arr.push(i);
  }
  return arr;
}
