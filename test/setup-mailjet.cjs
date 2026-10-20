// Test-only values. Identity tests override the mailer; transport tests mock fetch.
process.env.MAIL_FROM = 'tests@example.test';
process.env.MAILJET_API_KEY = 'test-only-api-key';
process.env.MAILJET_SECRET_KEY = 'test-only-secret-key';
