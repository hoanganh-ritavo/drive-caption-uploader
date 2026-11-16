import express from 'express';
import { chromium, Page } from 'playwright';
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
  const srtItem = pickerFrame.locator('[role="option"], [role="gridcell"]').filter({
    has: pickerFrame.getByText(sub.fileName, { exact: true })
  }).first();

  await srtItem.waitFor({ state: 'attached', timeout: 10000 });
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
  const videoFullName = (await videoRow.locator('strong').first().innerText()).trim();
  if (videoFullName.startsWith('_')) {
    sendLog(`⏩ [BỎ QUA] "${videoFullName}" (bắt đầu bằng _)`);
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

  const srtElements = page.locator('tr[role="row"]:has-text(".srt") strong');
  const srtCount = await srtElements.count();
  const allSrtFiles: string[] = [];
  for (let i = 0; i < srtCount; i++) {
    allSrtFiles.push((await srtElements.nth(i).innerText()).trim());
  }

  const videoRows = page.locator('tr[role="row"]:has-text(".mp4")');
  const videoCount = await videoRows.count();
  sendLog(`🔎 [${folderName}] Có ${videoCount} video .mp4 và ${srtCount} file phụ đề.`);

  for (let i = 0; i < videoCount; i++) {
    const row = videoRows.nth(i);
    try {
      await processVideo(page, row, allSrtFiles, folderUrl, folderName);
    } catch (err) {
      sendLog(`❌ Lỗi video thứ ${i + 1}`);
      await page.keyboard.press('Escape');
    }
  }
}

async function discoverFolders(page: Page, rootUrls: string[]) {
  const result: { name: string; url: string }[] = [];
  for (const rootUrl of rootUrls) {
    await page.goto(rootUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    let folderRows = page.locator('tr[role="row"][data-target="folder"]');
    if ((await folderRows.count()) === 0) folderRows = page.locator('tr[role="row"]').filter({ hasText: '—' });

    const subCount = await folderRows.count();
    if (subCount > 0) {
      for (let i = 0; i < subCount; i++) {
        const row = folderRows.nth(i);
        const name = (await row.locator('strong').first().innerText()).trim();
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
        await processFolder(workerPage, folder.url, folder.name);
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