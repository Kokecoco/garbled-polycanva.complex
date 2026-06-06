/**
 * test-recovery.js
 * 
 * 復元コアロジックの動作確認スクリプト。
 * 「縺薙ｓ縺ｫ縺｡縺ｯ」（こんにちは）の復元テストを行います。
 */

import { textToSjisBytes } from './src/utf8-recovery.js';
import { performBeamSearch } from './src/beam-search.js';

async function runTest() {
  console.log('--- 復元ロジックテスト開始 ---');

  const garbledText = '縺薙ｓ縺ｫ縺｡縺ｯ';
  console.log(`入力文字化け文字列: ${garbledText}`);

  // 1. Shift-JIS バイト配列への変換
  let bytes = textToSjisBytes(garbledText);
  console.log('抽出された Shift-JIS バイト列 (Hex):');
  console.log(bytes.map(b => typeof b === 'number' ? b.toString(16).toUpperCase() : b).join(' '));

  // 2. ビームサーチによる復元探索
  console.log('\nビームサーチ実行中...');
  let candidates = await performBeamSearch(bytes, 100);
  console.log('--- 復元候補 (上位) ---');
  candidates.slice(0, 5).forEach((cand, idx) => {
    console.log(`${idx + 1}. [${cand.text}] (Score: ${cand.score.toFixed(4)})`);
  });

  if (candidates[0]?.text === 'こんにちは') {
    console.log('🎉 テスト1成功: 「こんにちは」に正しく復元されました！');
  } else {
    console.log('❌ テスト1失敗');
  }

  console.log('\n--- テスト2: 破損あり（? を含むケース） ---');
  const garbledText2 = '縺薙ｓ縺?縺｡縺ｯ'; // 「に」の部分が「?」（破損）になっている
  console.log(`入力文字化け文字列2: ${garbledText2}`);

  bytes = textToSjisBytes(garbledText2);
  console.log('抽出された Shift-JIS バイト列 (Hex):');
  console.log(bytes.map(b => typeof b === 'number' ? b.toString(16).toUpperCase() : b).join(' '));

  console.log('\nビームサーチ実行中...');
  candidates = await performBeamSearch(bytes, 100);
  console.log('--- 復元候補 (上位) ---');
  candidates.slice(0, 5).forEach((cand, idx) => {
    console.log(`${idx + 1}. [${cand.text}] (Score: ${cand.score.toFixed(4)})`);
  });

  const hasHello = candidates.some(c => c.text === 'こんにちは');
  if (hasHello) {
    console.log('🎉 テスト2成功: 破損テキストから「こんにちは」が候補に復元されました！');
  } else {
    console.log('❌ テスト2失敗');
  }

  const bestResult = candidates[0]?.text;
  if (bestResult === 'こんにちは') {
    console.log('\n🎉 テスト成功: 「こんにちは」に正しく復元されました！');
  } else {
    console.log(`\n❌ テスト失敗: 最優先候補が [${bestResult}] となっています。`);
  }
}

runTest().catch(console.error);
