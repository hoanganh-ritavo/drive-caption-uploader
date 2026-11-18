import express from 'express';
import { chromium, FrameLocator, Locator, Page } from 'playwright';
import * as path from 'path';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients: express.Response[] = [];
function sendLog(msg: string) {
  console.log(msg);
  sseClients.forEach(res => res.write(`data: ${JSON.stringify(msg)}\n\n`));
}

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ==========================================
// API DÀNH RIÊNG CHO ĐĂNG NHẬP LẦN ĐẦU
// ==========================================
app.post('/api/login', async (req, res) => {
  res.json({ status: 'opening' });
  sendLog('\n🔑 [ĐĂNG NHẬP] Đang mở trình duyệt Chrome...');

  const userDataDir = path.join(__dirname, 'drive-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 850 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  if(!page) {
    sendLog('❌ Không thể tạo trang mới để đăng nhập.');
    await context.close();
    return;
  }
  await page.goto('https://accounts.google.com/');
  sendLog('👉 Vui lòng đăng nhập tài khoản Google trên cửa sổ Chrome vừa mở.');
  sendLog('💡 Sau khi đăng nhập thành công, bạn có thể đóng cửa sổ Chrome lại và quay lại web bấm Run.');
});

// ==========================================
// LOGIC AUTOMATION CHÍNH
// ==========================================
interface SubtitleInfo {
  fileName: string;
  langText: 'Tiếng Anh' | 'Tiếng Việt';
  title: string;
}

async function getRowName(row: Locator): Promise<string> {
  const strong = row.locator('strong').first();
  if (await strong.count()) return (await strong.innerText()).trim();
  return (await row.innerText()).split('\n')[0].trim();
}

/** Scroll the Drive picker viewport in steps so lazy-loaded rows are rendered. */
async function findFileInPicker(pickerFrame: FrameLocator, fileName: string) {
  const item = () => pickerFrame.locator('[role="option"], [role="gridcell"]').filter({
    has: pickerFrame.getByText(fileName, { exact: true })
  }).first();

  for (let attempt = 0; attempt < 40; attempt++) {
    const match = item();
    if (await match.count()) return match;

    // Drive's picker uses an inner scrolling pane. Advance every scrollable
    // pane a viewport at a time; this also triggers its lazy loading.
    await pickerFrame.locator('body').evaluate((body: HTMLElement) => {
      const panes = [body, ...Array.from(body.querySelectorAll<HTMLElement>('*'))]
        .filter(el => el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 0);
      for (const pane of panes) pane.scrollTop = Math.min(pane.scrollTop + Math.max(pane.clientHeight * 0.8, 300), pane.scrollHeight);
    });
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return item();
}

/** Scroll a Drive list to its end while collecting names from each lazy-loaded batch. */
async function collectRowsWhileScrolling(page: Page, selector: string): Promise<string[]> {
  const names = new Set<string>();
  let stableAtEnd = 0;
  let previousSignature = '';

  for (let attempt = 0; attempt < 120 && stableAtEnd < 3; attempt++) {
    const rows = page.locator(selector);
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const name = await getRowName(rows.nth(i));
      if (name) names.add(name);
    }

    const metrics = await page.locator('body').evaluate((body: HTMLElement) => {
      const rowNodes = Array.from(body.querySelectorAll<HTMLElement>('[role="row"]'));
      const candidates = new Set<HTMLElement>();
      for (const row of rowNodes) {
        let parent = row.parentElement;
        while (parent && parent !== body) {
          if (parent.scrollHeight > parent.clientHeight + 20 && parent.clientHeight > 0) candidates.add(parent);
          parent = parent.parentElement;
        }
      }
      const panes = [...candidates].sort((a, b) => {
        const rowDiff = b.querySelectorAll('[role="row"]').length - a.querySelectorAll('[role="row"]').length;
        return rowDiff || b.clientHeight - a.clientHeight;
      });
      const pane = panes[0] ?? document.scrollingElement as HTMLElement | null;
      if (!pane) return { top: 0, height: 0, client: 0 };
      pane.scrollTop = Math.min(pane.scrollTop + Math.max(pane.clientHeight * 0.8, 400), pane.scrollHeight);
      return { top: pane.scrollTop, height: pane.scrollHeight, client: pane.clientHeight };
    });
    await page.waitForTimeout(600);

    const signature = `${names.size}:${metrics.height}:${metrics.top}`;
    const atEnd = metrics.top + metrics.client >= metrics.height - 10;
    stableAtEnd = atEnd && signature === previousSignature ? stableAtEnd + 1 : 0;
    previousSignature = signature;
  }

  if (names.size === 0) throw new Error('Không đọc được tên file trong danh sách Drive.');
  return [...names];
}

async function findRowByNameWhileScrolling(page: Page, name: string) {
  const row = () => page.locator('[role="row"]').filter({ has: page.getByText(name, { exact: true }) }).first();
  await page.locator('body').evaluate((body: HTMLElement) => {
    const panes = new Set<HTMLElement>();
    for (const row of Array.from(body.querySelectorAll<HTMLElement>('[role="row"]'))) {
      let parent = row.parentElement;
      while (parent && parent !== body) {
        if (parent.scrollHeight > parent.clientHeight + 20 && parent.clientHeight > 0) panes.add(parent);
        parent = parent.parentElement;
      }
    }
    const pane = [...panes].sort((a, b) => b.querySelectorAll('[role="row"]').length - a.querySelectorAll('[role="row"]').length || b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement as HTMLElement | null;
    if (pane) pane.scrollTop = 0;
  });

  for (let attempt = 0; attempt < 120; attempt++) {
    const match = row();
    if (await match.count()) {
      await match.scrollIntoViewIfNeeded();
      return match;
    }
    await page.locator('body').evaluate((body: HTMLElement) => {
      const panes = new Set<HTMLElement>();
      for (const row of Array.from(body.querySelectorAll<HTMLElement>('[role="row"]'))) {
        let parent = row.parentElement;
        while (parent && parent !== body) {
          if (parent.scrollHeight > parent.clientHeight + 20 && parent.clientHeight > 0) panes.add(parent);
          parent = parent.parentElement;
        }
      }
      const pane = [...panes].sort((a, b) => b.querySelectorAll('[role="row"]').length - a.querySelectorAll('[role="row"]').length || b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement as HTMLElement | null;
      if (pane) pane.scrollTop = Math.min(pane.scrollTop + Math.max(pane.clientHeight * 0.8, 400), pane.scrollHeight);
    });
    await page.waitForTimeout(300);
  }
  throw new Error('Không tìm thấy hàng "' + name + '" sau khi cuộn hết danh sách.');
}

async function selectLanguage(targetPage: Page, targetLang: 'Tiếng Anh' | 'Tiếng Việt') {
  const listbox = targetPage.locator('[role="listbox"][aria-label*="Ngôn ngữ"]').first();
  await listbox.waitFor({ state: 'visible', timeout: 5000 });
  const selectedOption = listbox.locator('[role="option"][aria-selected="true"]').first();
  const currentSelectedText = (await selectedOption.innerText()).trim();

  if (currentSelectedText === targetLang) return;

  sendLog(`         🔄 Đổi ngôn ngữ từ "${currentSelectedText}" sang "${targetLang}"...`);
  await listbox.click();
  await targetPage.waitForTimeout(500);

  const targetOption = targetPage.locator('[role="option"]').filter({ hasText: targetLang }).first();
  await targetOption.scrollIntoViewIfNeeded();
  await targetOption.click();
  await targetPage.waitForTimeout(500);
}

async function attachSingleSubtitle(targetPage: Page, sub: SubtitleInfo, folderUrl: string, folderName: string) {
  sendLog(`      ➕ Gắn file: "${sub.fileName}" (${sub.langText})`);

  const addCaptionBtn = targetPage.locator('[role="button"]:has-text("Thêm phụ đề mới"), button:has-text("Thêm phụ đề mới")').first();
  await addCaptionBtn.waitFor({ state: 'visible', timeout: 10000 });
  await addCaptionBtn.click();
  await targetPage.waitForTimeout(2000);

  const pickerLocator = targetPage.locator('iframe[src*="picker"]').last();
  await pickerLocator.waitFor({ state: 'attached', timeout: 10000 });
  const pickerFrame = pickerLocator.contentFrame();

  sendLog(`         🔍 Mở thư mục "${folderName}"...`);
  const searchInput = pickerFrame.locator('input[placeholder*="Tìm trong Drive"], input[placeholder*="dán URL"], input[type="text"]').first();
  await searchInput.waitFor({ state: 'visible', timeout: 8000 });
  await searchInput.click();
  await searchInput.fill(folderUrl);
  await searchInput.press('Enter');
  await targetPage.waitForTimeout(2000);

  const folderCard = pickerFrame.locator('[role="option"], [role="gridcell"]').filter({ hasText: folderName }).first();
  if (await folderCard.isVisible({ timeout: 4000 })) {
    await folderCard.dblclick();
    await targetPage.waitForTimeout(2000);
  }

  // Khớp chính xác 100% tên file
  const srtItem = await findFileInPicker(pickerFrame, sub.fileName);
  await srtItem.waitFor({ state: 'attached', timeout: 3000 });
  await srtItem.scrollIntoViewIfNeeded();
  await targetPage.waitForTimeout(400);
  await srtItem.click({ force: true });
  await targetPage.waitForTimeout(500);

  const insertBtn = pickerFrame.locator('[role="button"]:has-text("Chèn"), button:has-text("Chèn"), [role="button"]:has-text("Insert")').last();
  if (await insertBtn.isVisible({ timeout: 3000 })) {
    await insertBtn.click();
  } else {
    await srtItem.dblclick({ force: true });
  }
  await targetPage.waitForTimeout(2500);

  await selectLanguage(targetPage, sub.langText);

  if (sub.title) {
    sendLog(`         ✍️ Nhập tiêu đề: "${sub.title}"`);
    const titleInput = targetPage.locator('input[aria-label*="Tiêu đề của tệp phụ đề"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 5000 });
    await titleInput.click();
    await titleInput.fill(sub.title);
  }
  await targetPage.waitForTimeout(400);

  const uploadBtn = targetPage.locator('[role="button"]:has-text("Tải lên"), button:has-text("Tải lên")').first();
  await uploadBtn.waitFor({ state: 'visible', timeout: 5000 });
  await uploadBtn.click();
  sendLog(`      ✅ Đã tải lên xong: "${sub.fileName}"!`);
  await targetPage.waitForTimeout(3500);
}

async function processVideo(page: Page, videoRow: any, allSrtFiles: string[], folderUrl: string, folderName: string) {
  const videoFullName = await getRowName(videoRow);
  if (videoFullName.startsWith('_') || videoFullName.startsWith('._')) {
    sendLog(`⏩ [BỎ QUA] "${videoFullName}" (bắt đầu bằng _ hoặc ._)`);
    return;
  }

  const baseName = videoFullName.replace(/\.mp4$/i, '').trim();
  sendLog(`\n🎬 [XỬ LÝ VIDEO] "${videoFullName}"`);

  const targetSubs: SubtitleInfo[] = [];
  const enFile = `${baseName}_en.srt`;
  const viFile = `${baseName}_vi.srt`;
  const biFile = `${baseName}.srt`;

  if (allSrtFiles.includes(enFile)) targetSubs.push({ fileName: enFile, langText: 'Tiếng Anh', title: '' });
  if (allSrtFiles.includes(viFile)) targetSubs.push({ fileName: viFile, langText: 'Tiếng Việt', title: '' });
  if (allSrtFiles.includes(biFile)) targetSubs.push({ fileName: biFile, langText: 'Tiếng Việt', title: 'Song Ngữ' });

  if (targetSubs.length === 0) return;

  await videoRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const moreActionsBtn = videoRow.locator('button[aria-label*="Thao tác khác"], button[aria-label*="More actions"]').first();
  if (await moreActionsBtn.isVisible()) {
    await moreActionsBtn.click();
  } else {
    await videoRow.click({ button: 'right' });
  }
  await page.waitForTimeout(800);

  const fileInfoOption = page.locator('[role="menuitem"]').filter({ hasText: /thông tin về tệp|file information/i }).first();
  await fileInfoOption.waitFor({ state: 'visible', timeout: 5000 });
  await fileInfoOption.hover();
  await page.waitForTimeout(300);
  await fileInfoOption.click();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);

  const captionOption = page.locator('[role="menuitem"]').filter({ hasText: /phụ đề|caption/i }).first();
  await captionOption.waitFor({ state: 'visible', timeout: 6000 });

  const newTabPromise = page.waitForEvent('popup', { timeout: 15000 })
    .catch(() => page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null));
    
  await captionOption.click();
  const newTab = await newTabPromise;
  const targetPage = newTab || page;

  if (newTab) await newTab.waitForLoadState('domcontentloaded');
  await targetPage.waitForTimeout(2500);

  try {
    for (const sub of targetSubs) {
      await attachSingleSubtitle(targetPage, sub, folderUrl, folderName);
    }
    sendLog(`   🎉 [HOÀN TẤT] Video "${videoFullName}"`);
  } catch (err) {
    sendLog(`   ❌ Lỗi gắn phụ đề: ${err}`);
  } finally {
    if (newTab) {
      await newTab.close();
      await page.waitForTimeout(1000);
    }
  }
}

async function processFolder(page: Page, folderUrl: string, folderName: string) {
  sendLog(`\n📁 [BẮT ĐẦU LUỒNG] Thư mục: "${folderName}"`);
  await page.goto(folderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const allNames = await collectRowsWhileScrolling(page, '[role="row"]');
  const allSrtFiles = allNames.filter(name => /\.srt$/i.test(name));
  const videoNames = allNames.filter(name => /\.mp4$/i.test(name));
  const videoCount = videoNames.length;
  sendLog(`🔎 [${folderName}] Có ${videoCount} video .mp4 và ${allSrtFiles.length} file phụ đề.`);

  for (let i = 0; i < videoCount; i++) {
    const videoName = videoNames[i];
    try {
      const row = await findRowByNameWhileScrolling(page, videoName);
      await processVideo(page, row, allSrtFiles, folderUrl, folderName);
    } catch (err) {
      sendLog(`❌ Lỗi video "${videoName}" (thứ ${i + 1}): ${err}`);
      await page.keyboard.press('Escape');
    }
  }
}

async function discoverFolders(page: Page, rootUrls: string[]) {
  const result: { name: string; url: string }[] = [];
  for (const rootUrl of rootUrls) {
    await page.goto(rootUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    let folderRows = page.locator('[role="row"][data-target="folder"]');
    if ((await folderRows.count()) === 0) folderRows = page.locator('[role="row"]').filter({ hasText: '—' });

    await collectRowsWhileScrolling(page, '[role="row"]');
    folderRows = page.locator('[role="row"][data-target="folder"]');
    if ((await folderRows.count()) === 0) folderRows = page.locator('[role="row"]').filter({ hasText: '—' });

    const subCount = await folderRows.count();
    if (subCount > 0) {
      for (let i = 0; i < subCount; i++) {
        const row = folderRows.nth(i);
        const name = await getRowName(row);
        const id = await row.getAttribute('data-id');
        if (id) result.push({ name, url: `https://drive.google.com/drive/folders/${id}` });
      }
    } else {
      result.push({ name: 'Thư mục hiện tại', url: rootUrl });
    }
  }
  return result;
}

// ==========================================
// API BẮT ĐẦU CHẠY CHÍNH
// ==========================================
app.post('/api/start', async (req, res) => {
  const { folderUrls, concurrency = 2 } = req.body;
  res.json({ status: 'started' });

  const normalizedUrls = folderUrls.map((s: string) =>
    s.startsWith('http') ? s : `https://drive.google.com/drive/folders/${s}`
  );

  const userDataDir = path.join(__dirname, 'drive-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 850 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const discoveryPage = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    if(!discoveryPage) {
      sendLog('❌ Không thể tạo trang mới để quét thư mục.');
      await context.close();
      return;
    }

    // 1. KIỂM TRA ĐĂNG NHẬP THÔNG MINH
    await discoveryPage.goto(normalizedUrls[0], { waitUntil: 'domcontentloaded' });
    await discoveryPage.waitForTimeout(2000);

    // Nếu bị Google chuyển hướng sang trang đăng nhập
    if (discoveryPage.url().includes('accounts.google.com')) {
      sendLog('\n⚠️ [CHƯA ĐĂNG NHẬP] Bạn chưa đăng nhập tài khoản Google!');
      sendLog('👉 Hãy nhìn sang cửa sổ Chrome vừa mở và đăng nhập tài khoản của bạn.');
      sendLog('⏳ Script sẽ kiên nhẫn đợi bạn đăng nhập xong (tối đa 5 phút)...');

      // Tự động đợi đến khi người dùng đăng nhập xong (URL rời khỏi accounts.google.com)
      await discoveryPage.waitForURL(url => !url.href.includes('accounts.google.com'), { timeout: 300000 });
      sendLog('✅ Đã đăng nhập thành công! Bắt đầu tiến trình tự động...\n');
      await discoveryPage.waitForTimeout(3000);
    }

    // 2. BẮT ĐẦU QUÉT VÀ CHẠY
    const targetFolders = await discoverFolders(discoveryPage, normalizedUrls);
    sendLog(`🎯 Đã tìm thấy ${targetFolders.length} thư mục cần xử lý.`);

    let currentIndex = 0;
    const numWorkers = Math.min(concurrency, targetFolders.length);
    sendLog(`🚀 BẮT ĐẦU CHẠY SONG SONG ${numWorkers} LUỒNG...\n`);

    const workers = Array.from({ length: numWorkers }).map(async (_, workerId) => {
      const workerPage = await context.newPage();
      while (currentIndex < targetFolders.length) {
        const taskIndex = currentIndex++;
        const folder = targetFolders[taskIndex];
        if(!folder) break;
        sendLog(`\n⚡ [Luồng ${workerId + 1}] Bắt đầu làm: "${folder.name}"`);
        try {
          await processFolder(workerPage, folder.url, folder.name);
        } catch (err) {
          sendLog(`❌ [Luồng ${workerId + 1}] Lỗi thư mục "${folder.name}": ${err}`);
          await workerPage.keyboard.press('Escape').catch(() => {});
        }
      }
      await workerPage.close();
    });

    await Promise.all(workers);
    sendLog('\n🎉🎉🎉 ĐÃ HOÀN TẤT TẤT CẢ CÁC THƯ MỤC THÀNH CÔNG!');

  } catch (err) {
    sendLog(`\n❌ Có lỗi: ${err}`);
  } finally {
    sendLog('🔒 Đang đóng trình duyệt Chrome...');
    await context.close();
    sendLog('👋 Đã đóng trình duyệt an toàn!');
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 WEBSITE ĐANG CHẠY TẠI: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
