const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCloudUsageHtml,
  parsePercentage,
  getQuotaStatus,
  setSessionCookie,
} = require('./quota-monitor');

const SAMPLE_HTML = `
<!DOCTYPE html>
<html lang="en">
<body>
  <main>
    <h2>Cloud usage <span class="badge">Free</span></h2>
    <p>Cloud models and capabilities such as web search contribute to session and weekly limits.</p>

    <section>
      <h3>Session usage</h3>
      <div class="progress-bar" style="width: 6.4%">6.4% used</div>
      <p>Resets in 3 hours</p>
    </section>

    <section>
      <h3>Weekly usage</h3>
      <div class="progress-bar" style="width: 15.6%">15.6% used</div>
      <p>Resets in 6 days</p>
    </section>

    <section>
      <h3>Models used this week</h3>
      <ul>
        <li><span class="dot"></span> <span>nemotron-3-super</span> <span>3 requests</span></li>
        <li><span class="dot"></span> <span>nemotron-3-nano:30b</span> <span>3 requests</span></li>
        <li><span class="dot"></span> <span>minimax-m3</span> <span>32 requests</span></li>
        <li><span class="dot"></span> <span>gpt-oss:120b</span> <span>200 requests</span></li>
        <li><span class="dot"></span> <span>gpt-oss:20b</span> <span>495 requests</span></li>
      </ul>
      <input type="checkbox" id="notify"> Notify me when I'm close to hitting my usage limits
    </section>
  </main>
</body>
</html>
`;

test('parsePercentage extrai valores numéricos de texto com %', () => {
  assert.equal(parsePercentage('6.4% used'), 6.4);
  assert.equal(parsePercentage('15,6 %'), 15.6);
  assert.equal(parsePercentage('100%'), 100);
  assert.equal(parsePercentage('invalid'), 0);
});

test('parseCloudUsageHtml extrai métricas corretas do HTML de settings da Ollama', () => {
  const result = parseCloudUsageHtml(SAMPLE_HTML);
  assert.equal(result.source, 'cloud');
  assert.equal(result.plan, 'Free');
  assert.equal(result.session.usedPercent, 6.4);
  assert.equal(result.session.resetText, 'Reseta em 3 hours');
  assert.equal(result.weekly.usedPercent, 15.6);
  assert.equal(result.weekly.resetText, 'Reseta em 6 days');
  assert.equal(result.models.length, 5);

  const gpt20b = result.models.find((m) => m.name === 'gpt-oss:20b');
  assert.ok(gpt20b);
  assert.equal(gpt20b.requests, 495);

  const minimax = result.models.find((m) => m.name === 'minimax-m3');
  assert.ok(minimax);
  assert.equal(minimax.requests, 32);

  const nemotronNano = result.models.find((m) => m.name === 'nemotron-3-nano:30b');
  assert.ok(nemotronNano);
  assert.equal(nemotronNano.requests, 3);
});

test('parseCloudUsageHtml rejeita HTML de login ou sessão inválida', () => {
  const loginHtml = '<html><body><h1>Sign in to Ollama</h1><form action="/login"></form></body></html>';
  assert.throws(() => parseCloudUsageHtml(loginHtml), /Sessão expirada ou cookie inválido/);
});

test('getQuotaStatus retorna status unconfigured quando não há cookie configurado', async () => {
  setSessionCookie('');
  const status = await getQuotaStatus();
  assert.equal(status.source, 'unconfigured');
  assert.equal(status.hasCookie, false);
  assert.equal(status.session, null);
  assert.equal(status.weekly, null);
});
