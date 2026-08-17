/**
 * 6E-5 §6·§7 — relay 설정 인식 파생 상태 테스트.
 *  - boolean/enum 파생값만 — Secret 원문(PIN·RPC URL·주소값)이 응답에 없음.
 *  - readonly/submit/submission/mode/manifest/deployment/PIN/signer 파생 규칙.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveRelayEnvFlags,
  recordDeploymentVerification,
  __resetDeploymentVerificationForTests,
} from '../lib/relayActivationStatus';

const baseEnv = (): NodeJS.ProcessEnv => ({} as NodeJS.ProcessEnv);

beforeEach(() => __resetDeploymentVerificationForTests());

describe('deriveRelayEnvFlags', () => {
  it('빈 env → 전부 fail-closed (false/DISABLED)', () => {
    const f = deriveRelayEnvFlags(baseEnv(), false);
    expect(f).toEqual({
      relayReadonlyNetworkEnabled: false,
      relaySubmitNetworkEnabled: false,
      relaySubmissionEnabled: false,
      relayMode: 'DISABLED',
      relayManifestConfigured: false,
      relayDeploymentVerified: false,
      operatorPinConfigured: false,
      delegatedSignerEnabled: false,
    });
  });

  it("정확히 'true' 문자열만 활성 — 'TRUE'/'1'/공백 등은 전부 false", () => {
    for (const v of ['TRUE', '1', ' true', 'yes', '']) {
      const env = baseEnv();
      env.GMX_RELAY_READONLY_NETWORK_ENABLED = v;
      env.GMX_RELAY_NETWORK_ENABLED = v;
      env.GMX_RELAY_SUBMISSION_ENABLED = v;
      env.DELEGATED_SIGNER_ENABLED = v;
      const f = deriveRelayEnvFlags(env, true);
      expect(f.relayReadonlyNetworkEnabled).toBe(false);
      expect(f.relaySubmitNetworkEnabled).toBe(false);
      expect(f.relaySubmissionEnabled).toBe(false);
      expect(f.delegatedSignerEnabled).toBe(false);
    }
  });

  it('Production 기대 조합: readonly=true, submit=false, submission=false, mode=DISABLED, PIN=true, signer=false', () => {
    const env = baseEnv();
    env.GMX_RELAY_READONLY_NETWORK_ENABLED = 'true';
    env.OPERATOR_MASTER_PIN = 'x'.repeat(12);
    env.DELEGATED_SIGNER_ENABLED = 'false';
    const f = deriveRelayEnvFlags(env, true);
    expect(f.relayReadonlyNetworkEnabled).toBe(true);
    expect(f.relaySubmitNetworkEnabled).toBe(false);
    expect(f.relaySubmissionEnabled).toBe(false);
    expect(f.relayMode).toBe('DISABLED');
    expect(f.relayManifestConfigured).toBe(true);
    expect(f.operatorPinConfigured).toBe(true);
    expect(f.delegatedSignerEnabled).toBe(false);
  });

  it('relayMode: LIVE/DRY_RUN만 인식, 그 외 전부 DISABLED', () => {
    const mk = (m: string) => {
      const env = baseEnv();
      env.GMX_RELAY_MODE = m;
      return deriveRelayEnvFlags(env, false).relayMode;
    };
    expect(mk('LIVE')).toBe('LIVE');
    expect(mk('DRY_RUN')).toBe('DRY_RUN');
    expect(mk('live')).toBe('DISABLED');
    expect(mk('PAPER')).toBe('DISABLED');
    expect(mk('')).toBe('DISABLED');
  });

  it('relayDeploymentVerified: attempted && ok 일 때만 true', () => {
    expect(deriveRelayEnvFlags(baseEnv(), false).relayDeploymentVerified).toBe(false);
    recordDeploymentVerification({ ok: false, atMs: 1, basis: [], failures: ['f'] });
    expect(deriveRelayEnvFlags(baseEnv(), false).relayDeploymentVerified).toBe(false);
    recordDeploymentVerification({ ok: true, atMs: 2, basis: ['b'], failures: [] });
    expect(deriveRelayEnvFlags(baseEnv(), false).relayDeploymentVerified).toBe(true);
  });

  it('응답에 Secret 원문이 포함되지 않는다 (PIN·RPC URL 값 미노출)', () => {
    const env = baseEnv();
    env.OPERATOR_MASTER_PIN = 'super-secret-pin-000000';
    env.GMX_RPC_URL = 'https://rpc.example/KEY123';
    env.GMX_RELAY_READONLY_NETWORK_ENABLED = 'true';
    const serialized = JSON.stringify(deriveRelayEnvFlags(env, true));
    expect(serialized).not.toContain('super-secret-pin');
    expect(serialized).not.toContain('rpc.example');
    expect(serialized).not.toContain('KEY123');
  });
});
