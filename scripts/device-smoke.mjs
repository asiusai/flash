import { chromium } from 'playwright'

const url = process.env.FLASH_URL ?? 'https://flash.asius.ai'
const choice = process.env.FLASH_CHOICE ?? 'openpilot'
if (!['openpilot', 'base', 'bootloader'].includes(choice)) throw new Error(`Unsupported FLASH_CHOICE: ${choice}`)
const storage = 'UFS'
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
const browser = await chromium.launch({
  executablePath,
  headless: false,
  args: ['--enable-experimental-web-platform-features'],
})

try {
  const context = await browser.newContext()
  // Test a signed candidate with the production bundle, without a live-reload server.
  if (process.env.FLASH_BOOT_MANIFEST) {
    const candidate = process.env.FLASH_BOOT_MANIFEST
    await context.route('https://vamos.asius.ai/bootloader/uboot.json*', route => {
      const suffix = route.request().url().endsWith('.sig') ? '.sig' : ''
      return route.continue({ url: candidate + suffix })
    })
  }
  const page = await context.newPage()
  // Chromium requires selection in its native WebUSB chooser.
  console.log('Select the intended Dragon in the browser USB chooser.')

  page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error(`[browser:error] ${error.stack ?? error.message}`))

  await page.goto(url, { waitUntil: 'networkidle' })
  const started = Date.now()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Asius v0', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  if (await page.getByRole('heading', { name: 'Unbind from qcserial' }).count()) {
    await page.getByRole('button', { name: 'Done', exact: true }).click()
  }
  await page.getByRole('checkbox', { name: 'Flash openpilot' }).setChecked(choice === 'openpilot')
  await page.getByRole('checkbox', { name: 'Flash VamOS' }).setChecked(choice !== 'bootloader')
  await page.getByRole('checkbox', { name: 'Flash U-Boot' }).setChecked(choice === 'bootloader' || process.env.FLASH_UBOOT === '1')
  await page
    .getByRole('button', { name: 'Connect', exact: true }).last()
    .click()

  let previous = ''
  const deadline = Date.now() + 45 * 60_000
  while (Date.now() < deadline) {
    const card = page.locator('#flash')
    const state = await card.getAttribute('data-phase')
    const detail = (await card.locator('#flash-status').innerText()).trim()
    const progress = ''
    const summary = `${state}: ${detail} ${progress ?? ''}`
    if (summary !== previous) {
      console.log(summary)
      previous = summary
    }
    if (state === 'done') process.exitCode = 0
    if (state === 'error') process.exitCode = 1
    if (state === 'done' || state === 'error') break
    await page.waitForTimeout(1000)
  }
  if (process.env.FLASH_BACKUP_DIR && await page.getByRole('link', { name: 'Download NOR backup' }).count()) {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download NOR backup' }).click()
    const download = await downloadPromise
    await download.saveAs(`${process.env.FLASH_BACKUP_DIR}/${download.suggestedFilename()}`)
  }
  console.log(JSON.stringify({ wizardSeconds: (Date.now() - started) / 1000, storage, choice }))
  if (process.exitCode !== 0) throw new Error('Browser EDL flash did not complete successfully')
} finally {
  await browser.close()
}
