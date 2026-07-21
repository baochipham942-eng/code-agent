export type WorkBuddyArtifactStage = 'draft' | 'final';

export interface WorkBuddyBusinessCheck {
  id: 'launch-status' | 'checklist' | 'completion' | 'release-package';
  label: string;
  expected: string;
  observed: string;
  passed: boolean;
}

export interface WorkBuddyBusinessEvaluation {
  verdict: 'pass' | 'fail';
  checks: WorkBuddyBusinessCheck[];
  findings: string[];
}

interface WorkBuddyArtifactModel {
  status: string;
  checklist: string;
  completion: string;
  releasePackage: string;
  bannerColor: string;
  bannerShadow: string;
  progressWidth: string;
  progressColor: string;
  statusLabel: string;
  statusCopy: string;
  reviewCopy: string;
  thirdCheckState: string;
}

function modelFor(stage: WorkBuddyArtifactStage): WorkBuddyArtifactModel {
  if (stage === 'final') {
    return {
      status: 'Ready to ship',
      checklist: '3 / 3 PASS',
      completion: '100%',
      releasePackage: 'Final artifact saved',
      bannerColor: '#16a34a',
      bannerShadow: 'rgba(22, 163, 74, 0.28)',
      progressWidth: '100%',
      progressColor: '#22c55e',
      statusLabel: 'Approved',
      statusCopy: 'All launch requirements are present and visually verified.',
      reviewCopy: 'The repaired artifact now satisfies the complete launch brief.',
      thirdCheckState: 'PASS',
    };
  }
  return {
    status: 'Needs revision',
    checklist: '2 / 3 PASS',
    completion: '67%',
    releasePackage: 'Draft only',
    bannerColor: '#dc2626',
    bannerShadow: 'rgba(220, 38, 38, 0.28)',
    progressWidth: '67%',
    progressColor: '#ef4444',
    statusLabel: 'Blocked',
    statusCopy: 'One launch requirement is missing and the package is incomplete.',
    reviewCopy: 'The first generated artifact must be revised before release.',
    thirdCheckState: 'FAIL',
  };
}

export function renderWorkBuddyArtifact(stage: WorkBuddyArtifactStage): string {
  const model = modelFor(stage);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WorkBuddy Launch Readiness</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #eef2ff;
        color: #172033;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 10% 0%, rgba(99, 102, 241, 0.18), transparent 34%),
          linear-gradient(180deg, #eef2ff 0%, #f8fafc 52%, #ffffff 100%);
      }
      main {
        width: min(1040px, calc(100% - 48px));
        margin: 36px auto;
      }
      .eyebrow {
        margin: 0 0 10px;
        color: #4f46e5;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: clamp(34px, 5vw, 58px);
        letter-spacing: -0.04em;
        line-height: 1;
      }
      .subtitle {
        max-width: 720px;
        margin: 16px 0 28px;
        color: #596579;
        font-size: 18px;
        line-height: 1.6;
      }
      .status-banner {
        display: flex;
        min-height: 132px;
        align-items: center;
        justify-content: space-between;
        gap: 28px;
        padding: 28px 34px;
        border-radius: 24px;
        background: ${model.bannerColor};
        box-shadow: 0 22px 48px ${model.bannerShadow};
        color: white;
      }
      .status-banner strong {
        display: block;
        margin-top: 4px;
        font-size: 34px;
        letter-spacing: -0.025em;
      }
      .status-banner p {
        max-width: 440px;
        margin: 0;
        color: rgba(255, 255, 255, 0.9);
        font-size: 16px;
        line-height: 1.55;
      }
      .badge {
        flex: 0 0 auto;
        padding: 10px 16px;
        border: 1px solid rgba(255, 255, 255, 0.45);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
        font-size: 14px;
        font-weight: 800;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin: 24px 0;
      }
      .card {
        min-height: 148px;
        padding: 22px;
        border: 1px solid #dbe3f1;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 12px 30px rgba(30, 41, 59, 0.08);
      }
      .card span {
        color: #64748b;
        font-size: 13px;
        font-weight: 750;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .card strong {
        display: block;
        margin-top: 18px;
        font-size: 28px;
        letter-spacing: -0.025em;
      }
      .progress-track {
        height: 12px;
        margin-top: 20px;
        overflow: hidden;
        border-radius: 999px;
        background: #e2e8f0;
      }
      .progress-value {
        width: ${model.progressWidth};
        height: 100%;
        border-radius: inherit;
        background: ${model.progressColor};
      }
      .review {
        display: grid;
        grid-template-columns: 1.35fr 0.65fr;
        gap: 16px;
      }
      .review ul {
        display: grid;
        gap: 12px;
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }
      .review li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-radius: 12px;
        background: #f8fafc;
        color: #334155;
        font-weight: 650;
      }
      .review li b { color: #4f46e5; }
      .secret-field {
        width: 100%;
        margin-top: 18px;
        padding: 12px 14px;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: white;
        color: #0f172a;
      }
      .review-note {
        margin: 18px 0 0;
        color: #64748b;
        line-height: 1.55;
      }
      @media (max-width: 760px) {
        main { width: min(100% - 28px, 1040px); margin: 22px auto; }
        .status-banner { align-items: flex-start; flex-direction: column; }
        .metrics, .review { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body data-artifact-stage="${stage}" data-business-verdict="${stage === 'final' ? 'pass' : 'fail'}">
    <main>
      <p class="eyebrow">WorkBuddy generation review</p>
      <h1>Launch Readiness Brief</h1>
      <p class="subtitle">A generated launch artifact is opened in Managed System Chrome, reviewed from its rendered state, repaired, and verified again.</p>

      <section class="status-banner" id="status-banner" aria-label="Launch status ${model.status}">
        <div>
          <span>Launch status</span>
          <strong>Launch status: ${model.status}</strong>
        </div>
        <p>${model.statusCopy}</p>
        <div class="badge">${model.statusLabel}</div>
      </section>

      <section class="metrics" aria-label="Business completion metrics">
        <article class="card">
          <span>Checklist</span>
          <strong>Checklist: ${model.checklist}</strong>
        </article>
        <article class="card">
          <span>Completion</span>
          <strong>Completion: ${model.completion}</strong>
          <div class="progress-track" aria-hidden="true"><div class="progress-value"></div></div>
        </article>
        <article class="card">
          <span>Release package</span>
          <strong>Release package: ${model.releasePackage}</strong>
        </article>
      </section>

      <section class="review">
        <article class="card">
          <span>Review checklist</span>
          <ul>
            <li>Executive summary <b>PASS</b></li>
            <li>Readiness metrics <b>PASS</b></li>
            <li>Final release package <b>${model.thirdCheckState}</b></li>
          </ul>
        </article>
        <article class="card">
          <span>Protected release token</span>
          <input class="secret-field" id="release-token" type="password" autocomplete="off" aria-label="Protected release token">
          <p class="review-note">${model.reviewCopy}</p>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function observedValue(content: string, prefix: string): string {
  const line = content
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes(prefix));
  return line || 'missing';
}

export function evaluateWorkBuddyBusinessReadback(content: string): WorkBuddyBusinessEvaluation {
  const expected = [
    ['launch-status', 'Launch status', 'Launch status: Ready to ship'],
    ['checklist', 'Checklist', 'Checklist: 3 / 3 PASS'],
    ['completion', 'Completion', 'Completion: 100%'],
    ['release-package', 'Release package', 'Release package: Final artifact saved'],
  ] as const;
  const checks = expected.map(([id, label, value]): WorkBuddyBusinessCheck => ({
    id,
    label,
    expected: value,
    observed: observedValue(content, `${label}:`),
    passed: content.includes(value),
  }));
  const findings = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.label} did not satisfy ${check.expected}.`);
  return {
    verdict: findings.length === 0 ? 'pass' : 'fail',
    checks,
    findings,
  };
}
