import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src', // ソースコードのルートを src ディレクトリに指定
  base: './',  // 相対パスでビルドすることで、任意のサブディレクトリで動作可能にする
  build: {
    target: 'esnext', // ONNX Runtime や Transformers.js 用に最新のES仕様に設定
    outDir: '../dist', // 出力先をプロジェクトルートの dist に設定
    emptyOutDir: true, // ビルド前に出力ディレクトリをクリア
    minify: 'esbuild',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]'
      }
    }
  },
  server: {
    // WebWorkerやクロスオリジン分離対策（モデルのキャッシュ効率化などに役立つ）
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
