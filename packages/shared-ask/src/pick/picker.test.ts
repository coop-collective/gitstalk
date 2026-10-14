import { describe, expect, it } from 'vitest';

import type { DecisionModel, DecisionModelName, ModelRunner } from './decision-model';
import { DECISION_MODELS } from './decision-model';
import type { PickDecision } from './picker';
import { modelPicker, rulesPicker } from './picker';
import { pickerFrom } from './picker-from-env';

const decision: PickDecision = {
  id: 'lead',
  title: 'Lead the page',
  ask: 'Which fact first?',
  state: { run: 'finished' },
  candidates: [
    { id: 'growth', description: 'how far it grew', label: 'Growth' },
    { id: 'decision', description: 'a decision', label: 'Decision' },
    { id: 'drops', description: 'what fell off', label: 'Drops' },
  ],
  slots: 2,
  rule: () => ({ chosen: ['growth', 'decision', 'drops'], why: 'Rule: growth first.' }),
};

function runner(answer: unknown): ModelRunner {
  return { run: () => Promise.resolve(answer) };
}

function model(ai: ModelRunner, name: DecisionModelName = 'clef', budgetMs = 200): DecisionModel {
  return { spec: DECISION_MODELS[name], ai, gateway: 'default', budgetMs };
}

function spy(calls: unknown[]): ModelRunner {
  return {
    run: (id, input, options) => {
      calls.push({ id, input, options });
      return Promise.resolve({ answers: { lead: { choice: 'growth' } } });
    },
  };
}

const criteria = { growth: 'how far it grew', decision: 'a decision', drops: 'what fell off' };

describe('the rules picker', () => {
  it('keeps the rule order, cut to the slots', async () => {
    const receipt = await rulesPicker.decide(decision);
    expect(receipt.chosen).toEqual(['growth', 'decision']);
    expect(receipt.by).toBe('rules');
    expect(receipt.model).toBeNull();
    expect(receipt.why).toBe('Rule: growth first.');
  });
});

describe('the Clef picker', () => {
  it("puts Clef's choice first, orders the rest by probability and names the model", async () => {
    const answer = {
      model: 'clef-flash',
      answers: {
        lead: {
          type: 'choice',
          choice: 'drops',
          confidence: 0.7,
          probabilities: { drops: 0.7, decision: 0.2, growth: 0.1 },
        },
      },
      usage: { input_tokens: 40, output_tokens: 0 },
    };
    const receipt = await modelPicker(model(runner(answer))).decide(decision);
    expect(receipt.chosen).toEqual(['drops', 'decision']);
    expect(receipt.by).toBe('clef');
    expect(receipt.model).toBe('Clef Flash');
    expect(receipt.why).toBe('Clef ranked the candidates; ties follow the rule.');
    expect(receipt.confidence).toBe(0.7);
  });

  it('reads the answer wrapped the way the REST API returns it', async () => {
    const answer = { result: { result: { answers: { lead: { choice: 'decision' } } } } };
    const receipt = await modelPicker(model(runner(answer))).decide(decision);
    expect(receipt.chosen[0]).toBe('decision');
  });

  it('falls back to the rule when Clef picks something outside the candidates', async () => {
    const answer = { answers: { lead: { choice: 'launch-the-missiles' } } };
    const receipt = await modelPicker(model(runner(answer))).decide(decision);
    expect(receipt.by).toBe('rules');
    expect(receipt.model).toBeNull();
    expect(receipt.chosen).toEqual(['growth', 'decision']);
    expect(receipt.why).toContain('Clef did not answer');
    expect(receipt.why).toContain('not an option');
  });

  it('falls back to the rule when Clef does not answer within the budget', async () => {
    const slow: ModelRunner = { run: () => new Promise(() => undefined) };
    const receipt = await modelPicker(model(slow, 'clef', 20)).decide(decision);
    expect(receipt.by).toBe('rules');
    expect(receipt.why).toContain('no answer within 20 ms');
  });

  it('sends Clef Flash a choice question with the required model field, through the gateway', async () => {
    const calls: unknown[] = [];
    await modelPicker(model(spy(calls))).decide(decision);
    expect(calls).toEqual([
      {
        id: '@cf/cloudflare/clef-flash',
        input: {
          model: 'clef-flash',
          state: { run: 'finished' },
          questions: { lead: { type: 'choice', instructions: 'Which fact first?', criteria } },
        },
        options: { gateway: { id: 'default' } },
      },
    ]);
  });

  it('sends the 27B model as `clef`', async () => {
    const calls: unknown[] = [];
    await modelPicker(model(spy(calls), 'clef-27b')).decide(decision);
    expect(calls).toMatchObject([
      { id: '@cf/cloudflare/clef', input: { model: 'clef', state: { run: 'finished' } } },
    ]);
  });
});

describe('the Jev picker', () => {
  it('sends Jev the System One body without a model field and names Jev on the receipt', async () => {
    const calls: unknown[] = [];
    const receipt = await modelPicker(model(spy(calls), 'jev')).decide(decision);
    expect(calls).toEqual([
      {
        id: 'typesafe/jev',
        input: {
          state: { run: 'finished' },
          questions: { lead: { type: 'choice', instructions: 'Which fact first?', criteria } },
        },
        options: { gateway: { id: 'default' } },
      },
    ]);
    expect(receipt.by).toBe('jev');
    expect(receipt.why).toBe('Jev ranked the candidates; ties follow the rule.');
  });
});

describe('pickerFrom', () => {
  const ai = runner({ answers: {} });

  it('builds the Clef Flash picker for `clef`', () => {
    const picker = pickerFrom({ name: 'clef', ai, gateway: 'default' });
    expect(picker.name).toBe('clef');
    expect(picker.model).toBe('Clef Flash');
  });

  it('uses the rules for `rules`, an unknown name or a missing AI binding', () => {
    expect(pickerFrom({ name: 'rules', ai, gateway: '' })).toBe(rulesPicker);
    expect(pickerFrom({ name: 'gpt', ai, gateway: '' })).toBe(rulesPicker);
    expect(pickerFrom({ name: 'clef', ai: undefined, gateway: '' })).toBe(rulesPicker);
  });
});
