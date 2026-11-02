import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { applyPlugin, createConfig } from './adapter.mjs';

export const name = 'video-study';
export const inject = ['tools'];
export const Config = createConfig(z);
export function apply(ctx, config) {
  return applyPlugin(ctx, config, { defineTool, rank: BUNDLED_SKILL_RANK,
    authKey: credentialKey('video-study', 'bilibili') });
}
