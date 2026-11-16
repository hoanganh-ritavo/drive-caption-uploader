import 'dotenv/config';
import { chromium, Page } from 'playwright';
import * as path from 'path';

function getFolderUrlsFromEnv(): string[] {
  const rawIds = process.env.DRIVE_FOLDER_IDS || '';
  if (!rawIds.trim()) {
    console.error('❌ LỖI: Chưa cấu hình DRIVE_FOLDER_IDS trong file .env!');
    process.exit(1);
  }

  return rawIds
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => (item.startsWith('http') ? item : `https://drive.google.com/drive/folders/${item}`));
}

const CONFIG = {
  folderUrls: getFolderUrlsFromEnv(),
  userDataDir: path.join(__dirname, 'drive-profile'),
  
  // 👉 SỐ THƯ MỤC CHẠY SONG SONG CÙNG LÚC
  concurrency: 2,
};

interface SubtitleInfo {
  fileName: string;
  langText: 'Tiếng Anh' | 'Tiếng Việt';
  title: string;
}

/**
 * Chọn ngôn ngữ
 */
async function selectLanguage(targetPage: Page, targetLang: 'Tiếng Anh' | 'Tiếng Việt') {
  const listbox = targetPage.locator('[role="listbox"][aria-label*="Ngôn ngữ"]').first();
  await listbox.waitFor({ state: 'visible', timeout: 5000 });

  const selectedOption = listbox.locator('[role="option"][aria-selected="true"]').first();
  const currentSelectedText = (await selectedOption.innerText()).trim();

  if (currentSelectedText === targetLang) {
    return;
  }

  console.log(`         🔄 Đổi ngôn ngữ từ "${currentSelectedText}" sang "${targetLang}"...`);
  await listbox.click();
  await targetPage.waitForTimeout(500);

  const targetOption = targetPage.locator('[role="option"]').filter({ hasText: targetLang }).first();
  await targetOption.scrollIntoViewIfNeeded();
  await targetOption.click();
  await targetPage.waitForTimeout(500);
}

/**
 * Gắn 1 file phụ đề cụ thể (KHỚP CHÍNH XÁC 100% TÊN FILE)
 */
async function attachSingleSubtitle(targetPage: Page, sub: SubtitleInfo, folderUrl: string, folderName: string) {
  console.log(`      ➕ Gắn file: "${sub.fileName}" (${sub.langText})`);

  // 1. Nút "Thêm phụ đề mới"
  const addCaptionBtn = targetPage.locator('[role="button"]:has-text("Thêm phụ đề mới"), button:has-text("Thêm phụ đề mới")').first();
  await addCaptionBtn.waitFor({ state: 'visible', timeout: 10000 });
  await addCaptionBtn.click();
  await targetPage.waitForTimeout(2000);

  // 2. Bắt iframe Picker mới nhất
  const pickerLocator = targetPage.locator('iframe[src*="picker"]').last();
  await pickerLocator.waitFor({ state: 'attached', timeout: 10000 });
  const pickerFrame = pickerLocator.contentFrame();

  // 3. Dán link thư mục vào ô tìm kiếm
  console.log(`         🔍 Mở thư mục "${folderName}"...`);
  const searchInput = pickerFrame.locator('input[placeholder*="Tìm trong Drive"], input[placeholder*="dán URL"], input[type="text"]').first();
  await searchInput.waitFor({ state: 'visible', timeout: 8000 });
  await searchInput.click();
  await searchInput.fill(folderUrl);
  await searchInput.press('Enter');
  await targetPage.waitForTimeout(2000);

  // 4. Nhấp đúp vào đúng thư mục hiện tại
  const folderCard = pickerFrame.locator('[role="option"], [role="gridcell"]').filter({ hasText: folderName }).first();
  if (await folderCard.isVisible({ timeout: 4000 })) {
    await folderCard.dblclick();
    await targetPage.waitForTimeout(2000);
  }

  // 5. CHỌN CHÍNH XÁC 100% FILE PHỤ ĐỀ (KHÔNG BAO GIỜ BỊ NHẦM BẢN SAO)
  console.log(`         👉 Tìm chính xác file "${sub.fileName}"...`);
  
  // Lọc thẻ card có chứa đúng 100% tên file
  const srtItem = pickerFrame.locator('[role="option"], [role="gridcell"]').filter({
    has: pickerFrame.getByText(sub.fileName, { exact: true })
  }).first();

  await srtItem.waitFor({ state: 'attached', timeout: 10000 });
  await srtItem.scrollIntoViewIfNeeded(); // Tự động cuộn xuống nếu nằm ở hàng dưới
  await targetPage.waitForTimeout(400);

  await srtItem.click({ force: true });
  await targetPage.waitForTimeout(500);

  // 6. Bấm nút "Chèn"
  console.log('         👉 Bấm nút "Chèn"...');
  const insertBtn = pickerFrame.locator('[role="button"]:has-text("Chèn"), button:has-text("Chèn"), [role="button"]:has-text("Insert")').last();
  if (await insertBtn.isVisible({ timeout: 3000 })) {
    await insertBtn.click();
  } else {
    await srtItem.dblclick({ force: true });
  }
  await targetPage.waitForTimeout(2500);

  // 7. Chọn ngôn ngữ
  await selectLanguage(targetPage, sub.langText);

  // 8. Nhập Tiêu đề (nếu là Song Ngữ)
  if (sub.title) {
    console.log(`         ✍️ Nhập tiêu đề: "${sub.title}"`);
    const titleInput = targetPage.locator('input[aria-label*="Tiêu đề của tệp phụ đề"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 5000 });
    await titleInput.click();
    await titleInput.fill(sub.title);
  }
  await targetPage.waitForTimeout(400);

  // 9. Bấm nút "Tải lên"
  console.log('         👉 Bấm nút "Tải lên"...');
  const uploadBtn = targetPage.locator('[role="button"]:has-text("Tải lên"), button:has-text("Tải lên")').first();
  await uploadBtn.waitFor({ state: 'visible', timeout: 5000 });
  await uploadBtn.click();
  console.log(`      ✅ Đã tải lên xong: "${sub.fileName}"!`);
  await targetPage.waitForTimeout(3500);
}

/**
 * Xử lý 1 video
 */
async function processVideo(page: Page, videoRow: any, allSrtFiles: string[], folderUrl: string, folderName: string) {
  const videoFullName = (await videoRow.locator('strong').first().innerText()).trim();

  // Bỏ qua file có tiền tố "_"
  if (videoFullName.startsWith('_')) {
    console.log(`⏩ [BỎ QUA] "${videoFullName}" (bắt đầu bằng _)`);
    return;
  }

  const baseName = videoFullName.replace(/\.mp4$/i, '').trim();
  console.log(`\n🎬 [XỬ LÝ VIDEO] "${videoFullName}"`);

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

  // Bắt tab popup riêng của từng page độc lập
  const newTabPromise = page.waitForEvent('popup', { timeout: 15000 })
    .catch(() => page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null));
    
  await captionOption.click();

  const newTab = await newTabPromise;
  const targetPage = newTab || page;

  if (newTab) {
    await newTab.waitForLoadState('domcontentloaded');
  }
  await targetPage.waitForTimeout(2500);

  try {
    for (const sub of targetSubs) {
      await attachSingleSubtitle(targetPage, sub, folderUrl, folderName);
    }
    console.log(`   🎉 [HOÀN TẤT] Video "${videoFullName}"`);
  } catch (err) {
    console.error(`   ❌ Lỗi gắn phụ đề video:`, err);
  } finally {
    if (newTab) {
      await newTab.close();
      await page.waitForTimeout(1000);
    }
  }
}

/**
 * Xử lý thư mục
 */
async function processFolder(page: Page, folderUrl: string, folderName: string) {
  console.log(`\n================================================================`);
  console.log(`📁 [BẮT ĐẦU LUỒNG] Thư mục: "${folderName}"`);
  console.log(`================================================================`);

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
  console.log(`🔎 [${folderName}] Có ${videoCount} video .mp4 và ${srtCount} file phụ đề.`);

  for (let i = 0; i < videoCount; i++) {
    const row = videoRows.nth(i);
    try {
      await processVideo(page, row, allSrtFiles, folderUrl, folderName);
    } catch (err) {
      console.error(`❌ [${folderName}] Lỗi video thứ ${i + 1}:`, err);
      await page.keyboard.press('Escape');
    }
  }

  console.log(`\n✅ [HOÀN TẤT LUỒNG] Thư mục: "${folderName}"`);
}

/**
 * Quét tìm các thư mục con
 */
async function discoverTargetFolders(page: Page, rootUrls: string[]): Promise<{ name: string; url: string }[]> {
  const result: { name: string; url: string }[] = [];

  for (const rootUrl of rootUrls) {
    console.log(`🔍 Đang quét thư mục: ${rootUrl}`);
    await page.goto(rootUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    let folderRows = page.locator('tr[role="row"][data-target="folder"]');
    if ((await folderRows.count()) === 0) {
      folderRows = page.locator('tr[role="row"]').filter({ hasText: '—' });
    }

    const subCount = await folderRows.count();
    if (subCount > 0) {
      for (let i = 0; i < subCount; i++) {
        const row = folderRows.nth(i);
        const name = (await row.locator('strong').first().innerText()).trim();
        const id = await row.getAttribute('data-id');
        if (id) {
          result.push({ name, url: `https://drive.google.com/drive/folders/${id}` });
        }
      }
    } else {
      result.push({ name: 'Thư mục gốc', url: rootUrl });
    }
  }

  return result;
}

/**
 * Chạy song song đa luồng (Worker Pool)
 */
async function runParallelWorkerPool(context: any, folders: { name: string; url: string }[], concurrency: number) {
  let currentIndex = 0;

  const workers = Array.from({ length: concurrency }).map(async (_, workerId) => {
    const workerPage = await context.newPage();
    
    while (currentIndex < folders.length) {
      const taskIndex = currentIndex++;
      const folder = folders[taskIndex];

      if(!folder) break;
      
      console.log(`\n⚡ [Luồng ${workerId + 1}] Nhận nhiệm vụ [${taskIndex + 1}/${folders.length}]: "${folder.name}"`);
      try {
        await processFolder(workerPage, folder.url, folder.name);
      } catch (err) {
        console.error(`❌ [Luồng ${workerId + 1}] Lỗi tại "${folder.name}":`, err);
      }
    }

    await workerPage.close();
  });

  await Promise.all(workers);
}

async function main() {
  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 850 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const discoveryPage = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  if(!discoveryPage) {
    console.error('❌ Không thể tạo trang mới để quét thư mục.');
    await context.close();
    return;
  }

  const targetFolders = await discoverTargetFolders(discoveryPage, CONFIG.folderUrls);
  console.log(`\n🎯 Đã tìm thấy tổng cộng ${targetFolders.length} thư mục cần xử lý:`);
  targetFolders.forEach((f, i) => console.log(`   ${i + 1}. ${f.name} -> ${f.url}`));

  if (targetFolders.length === 0) {
    console.log('Không có thư mục nào để làm.');
    return;
  }

  const concurrency = Math.min(CONFIG.concurrency, targetFolders.length);
  console.log(`\n🚀 BẮT ĐẦU CHẠY SONG SONG ${concurrency} LUỒNG CÙNG LÚC...\n`);
  
  await runParallelWorkerPool(context, targetFolders, concurrency);

  console.log('\n🎉🎉🎉 ĐÃ HOÀN TẤT TẤT CẢ CÁC THƯ MỤC CHUẨN XÁC 100%!');
}

main().catch(console.error);