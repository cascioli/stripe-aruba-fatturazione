// Runs before any test file is loaded — env must be set before env.ts is imported
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.DATABASE_URL = 'file:./test.db';
process.env.STRIPE_SECRET_KEY = 'sk_test_vitest_placeholder_00000000000000000';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_vitest_test_secret_placeholder_00000';
process.env.ARUBA_ENV = 'DEMO';
process.env.ARUBA_SEND_MODE = 'DRAFT';
process.env.ARUBA_USERNAME = 'test@example.com';
process.env.ARUBA_PASSWORD = 'testpassword';
process.env.ARUBA_CEDENTE_PIVA = '09876543210';
process.env.ARUBA_CEDENTE_DENOMINAZIONE = 'Test Company Srl';
process.env.ARUBA_CEDENTE_INDIRIZZO = 'Via Milano 10';
process.env.ARUBA_CEDENTE_CAP = '20100';
process.env.ARUBA_CEDENTE_COMUNE = 'Milano';
process.env.ARUBA_CEDENTE_PROVINCIA = 'MI';
process.env.ARUBA_CEDENTE_NAZIONE = 'IT';
process.env.ARUBA_CEDENTE_REGIME_FISCALE = 'RF01';
