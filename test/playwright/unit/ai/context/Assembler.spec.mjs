import {setup} from '../../../setup.mjs';

const appName = 'AiContextAssemblerTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}   from '@playwright/test';
import Neo              from 'neo.mjs/src/Neo.mjs';
import ContextAssembler from '../../../../../ai/context/Assembler.mjs';
import fs               from 'fs';
import path             from 'path';

test.describe('Neo.ai.context.Assembler', () => {
    let assembler;

    test.beforeEach(async () => {
        assembler = Neo.create({
            module: ContextAssembler,
            // We mock out the services to avoid real DB connections for this specific unit test
            initAsync: async function() {
                this.skillsContext = this.loadSkillsSync();
            }
        });
        await assembler.ready();
    });

    test('loadSkillsSync should extract YAML frontmatter for progressive disclosure', async () => {
        const skillsDir    = path.resolve(process.cwd(), '.agent/skills');
        const ideationPath = path.join(skillsDir, 'ideation-sandbox', 'SKILL.md');
        
        let hasIdeationSandbox = false;

        if (fs.existsSync(ideationPath)) {
             hasIdeationSandbox = true;
        }

        // Validate that if there's any file there, `<agent_skills>` tag wraps it
        if (assembler.skillsContext !== '') {
            expect(assembler.skillsContext).toContain('<agent_skills>');
        }
        
        if (hasIdeationSandbox) {
            expect(assembler.skillsContext).toContain('<skill>');
            expect(assembler.skillsContext).toContain('<path>');
            expect(assembler.skillsContext).toContain('ideation-sandbox/SKILL.md');
            expect(assembler.skillsContext).toContain('name: ideation-sandbox');
        }
    });

    test('augmentSystemPrompt strictly appends loaded skills to base prompt', async () => {
        const base = 'You are a mock agent.';
        const rag  = '\n[RAG Context]';
        
        // Setup mock skills context
        assembler.skillsContext = '\n<agent_skills>MockSkill</agent_skills>\n';
        
        const finalPrompt = assembler.augmentSystemPrompt(base, rag);
        
        expect(finalPrompt).toContain(base);
        expect(finalPrompt).toContain('<agent_skills>MockSkill</agent_skills>');
        expect(finalPrompt).toContain(rag);
    });

    test('formatMessages renders Decision Context from decisionContext with legacy thought fallback', () => {
        const formatted = assembler.formatMessages([
            {prompt: 'P1', decisionContext: 'DC1', response: 'R1', agent: 'antigravity', model: 'gemini'},
            {prompt: 'P2', thought: 'LegacyT2', response: 'R2'}
        ]);

        expect(formatted).toEqual([
            {role: 'user', content: 'P1'},
            {role: 'model', content: '[Agent: antigravity | Model: gemini]\nDecision Context: DC1\n\nR1'},
            {role: 'user', content: 'P2'},
            {role: 'model', content: 'Decision Context: LegacyT2\n\nR2'}
        ]);
    });
});
