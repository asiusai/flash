import { chromium } from 'playwright'

const url = process.env.FLASH_URL ?? 'http://localhost:5173'
const manifestUrl = process.env.FLASH_MANIFEST_URL
if (!manifestUrl) throw new Error('Set FLASH_MANIFEST_URL to the signed UFS release manifest')
const verifySha256 = process.env.FLASH_VERIFY_SHA256
if (verifySha256 && !/^[a-f0-9]{64}$/.test(verifySha256)) throw new Error('Invalid FLASH_VERIFY_SHA256')
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
const browser = await chromium.launch({
  executablePath,
  headless: false,
  args: ['--enable-experimental-web-platform-features'],
})

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  // Chromium requires selection in its native WebUSB chooser.
  console.log('Select the intended Dragon in the browser USB chooser.')

  page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error(`[browser:error] ${error.stack ?? error.message}`))

  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(
    async ({ manifestUrl, verifySha256 }) => {
      const [{ QdlDevice, STORAGE_TARGETS }, { downloadVerified, loadSignedManifest }] = await Promise.all([import('/src/lib/qdl.ts'), import('/src/lib/manifest.ts')])
      const manifest = await loadSignedManifest(manifestUrl)
      const programmer = await downloadVerified(manifest.programmer.url, manifest.programmer.size, manifest.programmer.sha256)

      const button = document.createElement('button')
      button.id = 'device-identify'
      button.textContent = 'Identify EDL device'
      const output = document.createElement('pre')
      output.id = 'device-identify-result'
      document.body.replaceChildren(button, output)

      button.addEventListener('click', async () => {
        output.dataset.status = 'running'
        output.textContent = 'Connecting to the EDL device…'
        try {
          // This diagnostic deliberately stops after the read-only storage query.
          const device = new QdlDevice(
            Uint8Array.from(programmer).buffer,
            STORAGE_TARGETS.find((target) => target.sectorSize === manifest.sector_size),
          )
          await device.connect()
          const storage = await device.getStorageInfo()
          if (verifySha256) await device.verify(0, manifest.sector_size, verifySha256)
          output.dataset.status = 'done'
          output.textContent = JSON.stringify({ serial: device.serial, target: device.storageLabel, storage, verified: Boolean(verifySha256) }, null, 2)
        } catch (error) {
          output.dataset.status = 'error'
          output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error)
        }
      })
    },
    { manifestUrl, verifySha256 },
  )

  await page.locator('#device-identify').click()
  const output = page.locator('#device-identify-result')
  await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#device-identify-result')?.dataset.status ?? ''), undefined, {
    timeout: 60_000,
  })
  const status = await output.getAttribute('data-status')
  const result = (await output.innerText()).trim()
  console.log(result)
  if (status !== 'done') process.exitCode = 1
} finally {
  await browser.close()
}
