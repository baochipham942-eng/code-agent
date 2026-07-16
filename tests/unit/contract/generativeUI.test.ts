import { describe, expect, it } from 'vitest';
import {
  canonicalizeNeoUISpec,
  extractNeoUIRawSpecs,
  parseNeoUIModelSpec,
} from '../../../src/shared/contract/generativeUI';

function validSpec() {
  return {
    schemaVersion: 1,
    title: 'Deploy options',
    initialState: { plan: 'safe' },
    components: [{
      id: 'plan',
      type: 'ChoiceGroup',
      props: { label: 'Choose', options: [{ value: 'safe', label: 'Safe' }] },
      bindings: { value: 'plan' },
      actions: [{ event: 'change', intent: 'state.update', valuePath: 'plan' }],
    }],
    fallback: 'Choose a deployment option.',
  };
}

describe('Generative UI contract', () => {
  it('accepts a bounded declarative model spec', () => {
    const result = parseNeoUIModelSpec(JSON.stringify(validSpec()));
    expect(result.success).toBe(true);
  });

  it.each(['issuer', 'instanceId', 'nonce', 'manifestId'])('rejects Host-owned field %s', (field) => {
    const result = parseNeoUIModelSpec(JSON.stringify({ ...validSpec(), [field]: 'forged' }));
    expect(result).toMatchObject({ success: false });
  });

  it('rejects arbitrary code and approval intents', () => {
    const spec = validSpec();
    spec.components[0].props = { command: 'rm -rf /' };
    spec.components[0].actions = [{
      event: 'submit',
      intent: 'approval.respond',
      valuePath: 'plan',
    }];
    const result = parseNeoUIModelSpec(JSON.stringify(spec));
    expect(result).toMatchObject({ success: false });
  });

  it('rejects undeclared fields and URL or event-handler aliases at every model boundary', () => {
    expect(parseNeoUIModelSpec(JSON.stringify({ ...validSpec(), extra: true }))).toMatchObject({ success: false });

    const nodeField = validSpec();
    Object.assign(nodeField.components[0], { rawDom: '<button>approve</button>' });
    expect(parseNeoUIModelSpec(JSON.stringify(nodeField))).toMatchObject({ success: false });

    const urlAlias = validSpec();
    urlAlias.components[0].props = { imageURL: 'https://attacker.example/pixel', onClick: 'steal()' };
    expect(parseNeoUIModelSpec(JSON.stringify(urlAlias))).toMatchObject({ success: false });

    const actionField = validSpec();
    Object.assign(actionField.components[0].actions[0], { payload: { approval: true } });
    expect(parseNeoUIModelSpec(JSON.stringify(actionField))).toMatchObject({ success: false });
  });

  it('rejects duplicate ids and unsupported components', () => {
    const duplicate = validSpec();
    duplicate.components.push({ ...duplicate.components[0] });
    expect(parseNeoUIModelSpec(JSON.stringify(duplicate))).toMatchObject({ success: false });

    const unknown = validSpec();
    unknown.components[0].type = 'ArbitraryHTML';
    expect(parseNeoUIModelSpec(JSON.stringify(unknown))).toMatchObject({ success: false });
  });

  it('canonicalizes key order and extracts complete fences only', () => {
    const first = parseNeoUIModelSpec(JSON.stringify(validSpec()));
    const reordered = parseNeoUIModelSpec(JSON.stringify({
      fallback: validSpec().fallback,
      components: validSpec().components,
      initialState: validSpec().initialState,
      title: validSpec().title,
      schemaVersion: 1,
    }));
    expect(first.success && reordered.success).toBe(true);
    if (!first.success || !reordered.success) return;
    expect(canonicalizeNeoUISpec(first.spec)).toBe(canonicalizeNeoUISpec(reordered.spec));

    const content = `\`\`\`neo_ui\n${JSON.stringify(validSpec())}\n\`\`\`\n\`\`\`neo_ui\n{`;
    expect(extractNeoUIRawSpecs(content)).toHaveLength(1);
  });
});
