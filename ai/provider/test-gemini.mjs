#!/usr/bin/env node

import Neo               from 'neo.mjs/src/Neo.mjs';
import * as core         from 'neo.mjs/src/core/_export.mjs';
import GeminiProvider    from './Gemini.mjs';
import path              from 'path';
import { fileURLToPath } from 'url';
import dotenv            from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.resolve(__dirname, '../../.env'), quiet: true});

async function run() {
    console.log('🧪 Testing Neo.ai.provider.Gemini...');

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.error('❌ Skipped: GEMINI_API_KEY not found in .env');
        return;
    }

    const provider = Neo.create(GeminiProvider, {
        // No apiKey needed here, it's picked up from process.env
    });

    try {
        // Test 1: Generate
        console.log('\n[1] Testing generate("Explain Quantum Computing in 1 sentence")...');
        const result = await provider.generate('Explain Quantum Computing in 1 sentence');
        console.log('✅ Result:', result.content);

        // Test 2: Stream
        console.log('\n[2] Testing stream("Count to 5")...');
        process.stdout.write('✅ Stream: ');
        for await (const chunk of provider.stream('Count to 5')) {
            process.stdout.write(chunk);
        }
        process.stdout.write('\n');

    } catch (error) {
        console.error('💥 Error:', error);
    }
}

run();
