import { defineConfig } from 'vitest/config';

// The server is compiled with NodeNext, so source files import each other with
// explicit `./x.js` specifiers that resolve to `./x.ts` on disk. Vite/Vitest
// does not remap `.js`→`.ts` by default, so this pre-resolver does it. Test
// files themselves use extensionless imports and don't need it, but the modules
// under test (e.g. mail/router → logger.js, supabase.js) do.
export default defineConfig({
    plugins: [
        {
            name: 'nodenext-js-to-ts',
            enforce: 'pre',
            async resolveId(source, importer) {
                if (importer && source.startsWith('.') && source.endsWith('.js')) {
                    const resolved = await this.resolve(source.slice(0, -3) + '.ts', importer, { skipSelf: true });
                    if (resolved) return resolved;
                }
                return null;
            },
        },
    ],
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Dummy env so import-time reads (supabase.ts throws without these;
        // encryption.ts needs a 64-hex key) don't blow up. No real services are hit.
        env: {
            NODE_ENV: 'test',
            SUPABASE_URL: 'http://localhost:54321',
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
            SUPABASE_ANON_KEY: 'test-anon-key',
            ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
            // posthog.ts constructs its client at import and throws without a key.
            POSTHOG_API_KEY: 'phc_test_key_not_real',
            POSTHOG_HOST: 'http://localhost:9999',
        },
    },
});
