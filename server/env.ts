// Imported first by main.ts so .env is loaded before any module reads process.env.
try { process.loadEnvFile(); } catch { /* .env is optional */ }
