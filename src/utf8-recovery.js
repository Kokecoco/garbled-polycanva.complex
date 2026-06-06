/**
 * utf8-recovery.js
 * 
 * ブラウザの TextDecoder('shift-jis') を利用して、
 * 実行時に Shift-JIS バイトと Unicode 文字の双方向マッピングテーブルを動的に構築します。
 * これにより、静的な巨大マッピングファイルを同梱することなく、正確なエンコード・デコードを実現します。
 */

let sjisToUnicode = null;
let unicodeToSjis = null;

/**
 * Shift-JIS と Unicode のマッピングテーブルを初期化します。
 * 一度初期化されると、以降はキャッシュされたテーブルを返します。
 */
export function initSjisTables() {
  if (sjisToUnicode && unicodeToSjis) {
    return { sjisToUnicode, unicodeToSjis };
  }

  sjisToUnicode = new Map();
  unicodeToSjis = new Map();

  const decoder = new TextDecoder('shift-jis', { fatal: false });

  // 1. 1バイト文字の走査 (ASCII: 0x00-0x7F, 半角カナ: 0xA1-0xDF)
  for (let b1 = 0x00; b1 <= 0xFF; b1++) {
    if ((b1 >= 0x00 && b1 <= 0x7F) || (b1 >= 0xA1 && b1 <= 0xDF)) {
      const buf = new Uint8Array([b1]);
      const char = decoder.decode(buf);
      
      // 置換文字 (\uFFFD) や空文字でない場合のみ有効な文字として登録
      if (char && char !== '\uFFFD') {
        sjisToUnicode.set(b1, char);
        unicodeToSjis.set(char, [b1]);
      }
    }
  }

  // 2. 2バイト文字の走査
  // 第1バイト: 0x81-0x9F, 0xE0-0xFC
  // 第2バイト: 0x40-0x7E, 0x80-0xFC
  const b1Ranges = [
    [0x81, 0x9F],
    [0xE0, 0xFC]
  ];

  for (const [start, end] of b1Ranges) {
    for (let b1 = start; b1 <= end; b1++) {
      for (let b2 = 0x40; b2 <= 0xFC; b2++) {
        if (b2 === 0x7F) continue; // Shift-JISの制御コード回避

        const buf = new Uint8Array([b1, b2]);
        const char = decoder.decode(buf);

        if (char && char !== '\uFFFD') {
          const key = (b1 << 8) | b2;
          sjisToUnicode.set(key, char);
          unicodeToSjis.set(char, [b1, b2]);
        }
      }
    }
  }

  return { sjisToUnicode, unicodeToSjis };
}

/**
 * 文字化け文字列をShift-JISのバイト配列（不確定バイトを含む）に変換します。
 * @param {string} text 文字化け文字列
 * @returns {Array<number|string>} バイト値（0x00-0xFF）または 'UNK'（不明なバイトを表す文字列）の配列
 */
export function textToSjisBytes(text) {
  const { unicodeToSjis } = initSjisTables();
  const bytes = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // ? や ？、置換文字は 'UNK' としてマーク
    if (char === '?' || char === '？' || char === '\uFFFD') {
      bytes.push('UNK');
    } else if (unicodeToSjis.has(char)) {
      bytes.push(...unicodeToSjis.get(char));
    } else {
      // マップにない未知の文字も 'UNK' とみなす
      bytes.push('UNK');
    }
  }

  return bytes;
}

/**
 * バイト配列（Uint8Array等）をUTF-8文字列として安全にデコードします。
 * デコードに失敗した場合はnullを返します。
 * @param {Array<number>|Uint8Array} bytes 
 * @returns {string|null}
 */
export function decodeUtf8Safe(bytes) {
  try {
    const uint8 = new Uint8Array(bytes);
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(uint8);
  } catch (e) {
    return null;
  }
}
