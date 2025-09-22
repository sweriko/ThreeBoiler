import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    open: true
  },
  build: {
    target: 'es2022'
  },
  assetsInclude: ['**/*.hdr', '**/*.exr', '**/*.wasm']
});


