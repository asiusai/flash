# Asius browser flasher

Based on [commaai/flash](https://github.com/commaai/flash), with the upstream wizard layout.

`https://flash.asius.ai` installs VamOS with WebUSB.
See [the VamOS spec](https://github.com/asiusai/asius/blob/master/specs/vamos.md) for release and recovery requirements.

The app verifies openpilot's signed VamOS reference.
It then selects the signed UFS factory manifest for that release.
R2 stores content-addressed image blocks and the native openpilot archive.

## Development

Run these commands in this repository:

```sh
bun install --frozen-lockfile
bun run dev
bun run test
bun run build
```

The development server proxies R2 downloads through `/__updates`.
Production uses R2 directly.
Development-only environment overrides cannot replace production manifests or signing keys.

## Hardware tests

Use a desktop Chromium browser with a display.
For local write tests, build first and use `bun run start`. Do not use a live-reload server.
Set `FLASH_BOOT_MANIFEST` to test a signed candidate recipe through the production bundle.
Select the intended Dragon in the browser's USB chooser.
Only UFS modules are supported.

This diagnostic reads storage identity without erasing or programming storage:

```sh
FLASH_MANIFEST_URL=https://vamos.asius.ai/vamos/releases/18.9/flash-ufs.json \
  bun run device-identify
```

Set `FLASH_VERIFY_SHA256` to verify the first storage sector against a known digest.

This test erases the selected device and installs the selected factory image:

```sh
FLASH_URL=https://flash.asius.ai FLASH_CHOICE=openpilot \
  bun run device-smoke
```

Use `FLASH_CHOICE=base` for VamOS alone.
The test records download, write, verification, and total flash times in its console output.
Verify Linux startup separately after the browser completes.
Factory flashing preserves the dedicated identity partition. It replaces OS and userdata.
Manifest version 3 excludes identity storage from all normal erase and write operations.
The flasher initializes the reserved range only when a valid old GPT has no identity partition.
A blank GPT can mean an interrupted flash, so it never permits identity erasure.

## Optional U-Boot installation

The three flash options persist in localStorage. VamOS and openpilot default to on; U-Boot defaults to off.
Disable VamOS to flash U-Boot alone. This preserves UFS and excludes openpilot, which requires the VamOS factory image.
The browser saves a verified 32 MiB NOR backup in IndexedDB and offers its download.
Keep that download outside the browser for recovery.

The timer starts after USB selection and includes programmer startup, backups, downloads, writes, verification, and reset.
It stops at success or failure. Completion does not measure Linux startup.
The displayed MB/s measures average programmed bytes per write time, including write acknowledgements.
Downloads and readback verification do not count toward that rate.
USB 2 or USB 3 comes from the active bulk endpoint packet sizes, not the device's USB capability version.

Signed firmware recipes accept known boot-chain revisions only.
The browser reconstructs retained firmware from the connected board.
Public templates contain U-Boot and image headers, with device firmware ranges zeroed.
Only XBL changes. Its original trailing bytes and every other NOR partition remain unchanged.
This does not install a different Radxa boot-firmware baseline.

`vamos/tools/build/package_uboot.py` generates recipes from private reference NOR backups and a built U-Boot core.
Production deployment runs from the Asius monorepo after its submodule pin changes.

Sign `uboot.json` with the OS release key before publishing it under `bootloader/` on R2.
Never publish the reference backups.
Set `UBOOT_REFERENCE_DIR` when running tests to check private firmware fixtures against the CLI-generated output.

For an attended maintenance test, set `FLASH_CHOICE=bootloader` and `FLASH_BACKUP_DIR` before running `device-smoke`.
For a full installation with U-Boot, set `FLASH_UBOOT=1`.
