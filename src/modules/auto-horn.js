// Module: Auto Horn & King's Reward Solver
// Sounds the hunter's horn when it is ready (after a random delay) and OCR-solves King's Reward puzzles.
// Ported from "Mousehunt Auto Horn & KR Solver (Slick's fork)" 0.6.1, a fork of daniellok's original
// (https://github.com/daniellok/mousehunt-auto-kr, MIT). Needs Tesseract.js (see @require in the header).
{
  const PUZZLE_ACTIVE_SELECTOR = '.puzzleView--active';
  const PUZZLE_IMAGE_SELECTOR = '.puzzleView__image > img';
  const PUZZLE_CODE_INPUT = '.puzzleView__code';
  const PUZZLE_SUBMIT_BUTTON = '.puzzleView__solveButton';
  const PUZZLE_NEW_CODE_LINK = '.puzzleView__requestNewPuzzleButton';
  const HORN_READY_SELECTOR = '.huntersHornView__horn--reveal';

  const pad = (n) => String(n).padStart(2, '0');
  const formatTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const log = (message) => console.log(`${formatTime(new Date())}: ${message}`);

  async function soundHorn() {
    const horn = document.querySelector(HORN_READY_SELECTOR);
    horn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(500);
    horn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await sleep(2000);
    const messageText = document.querySelector('.huntersHornView__message').textContent;
    if (messageText !== '') window.location.reload();
  }

  function getSecsToNextHorn() {
    const timerText = document.querySelector('.huntersHornView__timerState--type-countdown').textContent;
    const [mins, secs] = timerText.split(':');
    return Number(mins) * 60 + Number(secs);
  }

  function loadImage(img) {
    return new Promise((resolve, reject) => {
      const newImg = new Image();
      newImg.crossorigin = 'Anonymous';
      newImg.onload = () => resolve(newImg);
      newImg.onerror = () => reject();
      newImg.src = img.src;
    });
  }

  MH.register({
    id: 'auto-horn',
    name: 'Auto Horn & KR Solver',
    description: "Sounds the horn when it's ready and solves King's Reward puzzles with OCR.",
    settings: [
      { key: 'solveKR', type: 'checkbox', label: "Solve King's Reward automatically", default: true,
        help: 'Off: the horn pauses while a puzzle is up, and resumes once you solve it yourself.' },
      { key: 'hornDelayMin', type: 'number', label: 'Horn delay min', unit: 'sec', min: 0, max: 600, default: 10 },
      { key: 'hornDelayMax', type: 'number', label: 'Horn delay max', unit: 'sec', min: 0, max: 600, default: 180 },
      { key: 'krVerifyDelay', type: 'number', label: 'KR verify delay', unit: 'ms', min: 500, max: 30000, default: 3000, help: 'Wait after submitting before checking it worked.' },
      { key: 'krNewCodeDelay', type: 'number', label: 'KR new-code wait', unit: 'ms', min: 500, max: 30000, default: 5000 },
      { key: 'krPreSubmitDelay', type: 'number', label: 'KR pre-submit pause', unit: 'ms', min: 100, max: 10000, default: 1000 },
      { key: 'krRetryLimit', type: 'number', label: 'KR retry limit', min: 1, max: 10, default: 3, help: 'OCR attempts before giving up.' },
      { key: 'refreshIntervalMin', type: 'number', label: 'Auto-refresh', unit: 'min', min: 1, max: 240, default: 30 },
    ],
    // Carry over the tuning from the standalone script's settings panel.
    migrate: () => lsGet('mh_auto_horn_cfg_v1', null),
    requires: () => (document.getElementById('mousehuntContainer') ? null : 'MouseHunt page not found'),

    init(ctx) {
      const S = (key) => ctx.settings.get(key);
      let krPending = false; // the horn is paused for a manual King's Reward

      async function solveKR() {
        if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js is not loaded (check the @require line in your userscript manager)');
        const img = document.querySelector(PUZZLE_IMAGE_SELECTOR);
        const newImg = await loadImage(img);
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 58;
        canvas.getContext('2d').drawImage(newImg, 0, 0);
        const worker = await Tesseract.createWorker();
        let rawCode;
        try {
          await worker.loadLanguage('eng');
          await worker.initialize('eng');
          rawCode = (await worker.recognize(canvas)).data.text.trim();
        } finally {
          await worker.terminate().catch(() => {});
        }
        const code = rawCode.replaceAll(/[^A-Za-z0-9]/g, '');
        if (code.length !== 5) {
          log("OCR failed! Couldn't determine characters");
          await getNewCodeImage();
          return false;
        }
        log(`OCR success! Code: ${code}`);
        const codeInput = document.querySelector(PUZZLE_CODE_INPUT);
        codeInput.value = code;
        codeInput.dispatchEvent(new KeyboardEvent('keyup'));
        await sleep(S('krPreSubmitDelay'));
        document.querySelector(PUZZLE_SUBMIT_BUTTON).click();
        await sleep(S('krVerifyDelay'));
        return !document.querySelector('.puzzleView--active');
      }

      async function getNewCodeImage() {
        document.querySelector(PUZZLE_NEW_CODE_LINK).click();
        await sleep(S('krNewCodeDelay'));
      }

      const getRandomHornDelay = () => Math.max(Math.random() * S('hornDelayMax'), S('hornDelayMin'));

      const renderWaitingForHorn = (nextHornTime) => {
        const secs = Math.floor((nextHornTime - Date.now()) / 1e3);
        ctx.setStatus(`Waiting for next horn. Next horn at ${formatTime(new Date(nextHornTime))} (${secs} seconds)`);
      };

      async function getState() {
        if (document.querySelector(HORN_READY_SELECTOR)) {
          log('Sounding horn...');
          await soundHorn();
          log('Horn sounded!');
        }
        if (document.querySelector(PUZZLE_ACTIVE_SELECTOR)) {
          if (!S('solveKR')) {
            krPending = true;
            ctx.setStatus("King's Reward is up and auto-solve is off. Solve it yourself; the horn resumes after.", 'warn');
            return Date.now() + 5000;
          }
          log('Solving KR...');
          let success = false;
          let retryCount = 0;
          while (!success && retryCount < S('krRetryLimit')) {
            ctx.setStatus(`Solving KR (attempt ${retryCount + 1}/${S('krRetryLimit')})`);
            success = await solveKR();
            retryCount++;
            if (!success) log('Failed to solve KR, retrying...');
          }
          if (success) {
            log('KR solved!');
            window.location.reload();
          } else {
            alert(`Failed to solve KR ${S('krRetryLimit')} times. Please solve it manually and refresh the page when finished!`);
            return -1;
          }
        }
        krPending = false;
        const secsToNextHorn = getSecsToNextHorn();
        const nextHornTime = Date.now() + (secsToNextHorn + getRandomHornDelay()) * 1e3;
        renderWaitingForHorn(nextHornTime);
        log(`Next horn time: ${formatTime(new Date(nextHornTime))}`);
        return nextHornTime;
      }

      async function loop() {
        let nextHornTime = 0;
        const lastRefreshTime = Date.now();
        while (ctx.alive()) {
          if (Date.now() - lastRefreshTime > S('refreshIntervalMin') * 60000) window.location.reload();
          try {
            if (nextHornTime === -1) break;
            else if (nextHornTime > Date.now()) {
              if (nextHornTime < getSecsToNextHorn()) nextHornTime = await getState();
              if (!krPending) renderWaitingForHorn(nextHornTime);
              await sleep(1000);
            } else {
              nextHornTime = await getState();
            }
          } catch (e) {
            // The standalone script silently died here. Report it and try again shortly instead.
            ctx.log.warn(e);
            ctx.setStatus(`Error: ${e?.message || e}. Retrying...`, 'warn');
            nextHornTime = 0;
            await sleep(5000);
          }
        }
        if (nextHornTime === -1) ctx.setStatus("Stopped: couldn't solve the King's Reward. Solve it manually and refresh.", 'error');
      }

      ctx.setStatus('Starting...');
      loop();
    },
  });
}
