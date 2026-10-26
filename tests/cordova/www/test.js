const call = (action, ...args) => new Promise((resolve, reject) => cordova.exec(resolve, reject, 'EngineFixture', action, args));
const slot = document.querySelector('#slot');
const wait = async (condition) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out: ' + condition);
};
document.addEventListener(
  'deviceready',
  async () => {
    const reloaded = sessionStorage.getItem('engine-reload') === 'pending';
    const report = {
      platform: cordova.platformId,
      cycles: reloaded ? 3 : 0,
      reloaded,
      capacitorAbsent: typeof window.Capacitor === 'undefined',
      passed: false,
    };
    try {
      const rect = slot.getBoundingClientRect();
      await call('place', { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport: innerWidth });
      if (reloaded) {
        await wait(async () => !(await call('status')).visible);
        await call('native');
      }
      for (let cycle = 0; cycle < 3; cycle++) {
        await wait(() => slot.hasAttribute('data-native-ui-snapshot'));
        await call('web');
        await wait(async () => slot.hasAttribute('data-native-ui-snapshot-source') && !(await call('status')).visible);
        await call('native');
        await wait(async () => !slot.hasAttribute('data-native-ui-snapshot-source') && (await call('status')).visible);
        report.cycles++;
      }
      await call('none');
      await wait(async () => !(await call('status')).visible);
      if (!reloaded) {
        sessionStorage.setItem('engine-reload', 'pending');
        location.reload();
        return;
      }
      await call('native');
      await wait(async () => (await call('status')).visible);
      sessionStorage.removeItem('engine-reload');
      report.passed = true;
    } catch (error) {
      report.error = String(error);
    }
    document.querySelector('#result').textContent = JSON.stringify(report, null, 2);
    await call('report', report);
  },
  { once: true },
);
