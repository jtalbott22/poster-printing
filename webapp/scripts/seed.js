#!/usr/bin/env node
'use strict';
/**
 * One-time seed. Edit the SITE block, run `npm run seed`, copy the printed
 * secrets into each print host's .env. Safe to re-run: everything upserts,
 * but the HMAC secret is only generated once per host.
 */
const { migrate, q } = require('../src/db');
const security = require('../src/security');

migrate();

const SITE = {
  hosts: [
    { code: 'bowman-01', displayName: 'Bowman Hall print host',
      baseUrl: 'https://print-bowman.kent.edu:8443' },
  ],
  locations: [
    { code: 'bowman', displayName: 'Bowman Hall', building: 'Bowman Hall', room: '108',
      pickupHours: 'Mon–Fri 8:00a–5:00p', contactEmail: 'cshelpdesk@kent.edu',
      mapUrl: 'https://www.kent.edu/maps?building=bowman' },
    { code: 'science-research', displayName: 'Science Research Building',
      building: 'Science Research', room: '124', pickupHours: 'Mon–Fri 8:00a–4:30p',
      contactEmail: 'cshelpdesk@kent.edu' },
  ],
  printers: [
    { code: 'bowman-pro4100-36', displayName: 'Bowman — Canon PRO-4100 (36" roll)',
      hostCode: 'bowman-01', locationCode: 'bowman',
      windowsPrinterName: 'Canon PRO-4100-36',
      rollWidthIn: 36, printableWidthIn: 35.5, maxLengthIn: 120,
      driverPreset: 'Poster 36 Matte', targetDpi: 300, costPerSqFtCents: 165, sortOrder: 10 },
    { code: 'bowman-pro4100-42', displayName: 'Bowman — Canon PRO-4100 (42" roll)',
      hostCode: 'bowman-01', locationCode: 'bowman',
      windowsPrinterName: 'Canon PRO-4100-42',
      rollWidthIn: 42, printableWidthIn: 41.5, maxLengthIn: 120,
      driverPreset: 'Poster 42 Matte', targetDpi: 300, costPerSqFtCents: 165, sortOrder: 20 },
  ],
  supplies: [
    { sku: 'PFI-3100MBK', kind: 'ink', description: 'Canon PFI-3100 Matte Black 160 ml',
      inkCode: 'MBK', onHand: 2, reorderAt: 1, unitCostCents: 6900 },
    { sku: 'PFI-3100PBK', kind: 'ink', description: 'Canon PFI-3100 Photo Black 160 ml',
      inkCode: 'PBK', onHand: 2, reorderAt: 1, unitCostCents: 6900 },
    { sku: 'PFI-3100C', kind: 'ink', description: 'Canon PFI-3100 Cyan 160 ml',
      inkCode: 'C', onHand: 1, reorderAt: 1, unitCostCents: 6900 },
    { sku: 'PFI-3100M', kind: 'ink', description: 'Canon PFI-3100 Magenta 160 ml',
      inkCode: 'M', onHand: 1, reorderAt: 1, unitCostCents: 6900 },
    { sku: 'PFI-3100Y', kind: 'ink', description: 'Canon PFI-3100 Yellow 160 ml',
      inkCode: 'Y', onHand: 1, reorderAt: 1, unitCostCents: 6900 },
    { sku: 'ROLL-36-MATTE', kind: 'paper', description: '36" x 100\' matte coated roll',
      rollWidthIn: 36, onHand: 3, reorderAt: 1, unitCostCents: 8500 },
    { sku: 'ROLL-42-MATTE', kind: 'paper', description: '42" x 100\' matte coated roll',
      rollWidthIn: 42, onHand: 2, reorderAt: 1, unitCostCents: 9900 },
  ],
};

const out = { hosts: [], apiKeys: [] };

for (const h of SITE.hosts) {
  const existing = q.one('SELECT * FROM print_hosts WHERE code = ?', h.code);
  if (existing) {
    q.run('UPDATE print_hosts SET display_name = ?, base_url = ? WHERE id = ?',
      h.displayName, h.baseUrl, existing.id);
    out.hosts.push({ code: h.code, hmacSecret: existing.hmac_secret, note: 'existing' });
  } else {
    const hmac = security.randomToken(32);
    const apiKey = security.randomToken(24);
    q.run(
      `INSERT INTO print_hosts (code, display_name, base_url, api_key_hash, hmac_secret)
       VALUES (?,?,?,?,?)`,
      h.code, h.displayName, h.baseUrl, security.sha256hex(apiKey), hmac);
    out.hosts.push({ code: h.code, hmacSecret: hmac, note: 'new' });
  }
}

for (const l of SITE.locations) {
  q.run(
    `INSERT INTO locations (code, display_name, building, room, pickup_hours, map_url, contact_email)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
       building=excluded.building, room=excluded.room, pickup_hours=excluded.pickup_hours,
       map_url=excluded.map_url, contact_email=excluded.contact_email`,
    l.code, l.displayName, l.building, l.room, l.pickupHours, l.mapUrl || null, l.contactEmail);
}

for (const p of SITE.printers) {
  const host = q.one('SELECT id FROM print_hosts WHERE code = ?', p.hostCode);
  const loc = q.one('SELECT id FROM locations WHERE code = ?', p.locationCode);
  q.run(
    `INSERT INTO printers (code, display_name, print_host_id, location_id,
        windows_printer_name, roll_width_in, printable_width_in, max_length_in,
        driver_preset, target_dpi, cost_per_sq_ft_cents, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
       windows_printer_name=excluded.windows_printer_name,
       printable_width_in=excluded.printable_width_in, driver_preset=excluded.driver_preset,
       cost_per_sq_ft_cents=excluded.cost_per_sq_ft_cents`,
    p.code, p.displayName, host.id, loc.id, p.windowsPrinterName, p.rollWidthIn,
    p.printableWidthIn, p.maxLengthIn, p.driverPreset, p.targetDpi,
    p.costPerSqFtCents, p.sortOrder);
}

for (const s of SITE.supplies) {
  q.run(
    `INSERT INTO supplies (sku, kind, description, ink_code, roll_width_in, on_hand,
        reorder_at, unit_cost_cents)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(sku) DO UPDATE SET description=excluded.description,
       reorder_at=excluded.reorder_at, unit_cost_cents=excluded.unit_cost_cents`,
    s.sku, s.kind, s.description, s.inkCode || null, s.rollWidthIn || null,
    s.onHand, s.reorderAt, s.unitCostCents || null);
}

// An API key for Power Automate's inbound calls (pickup, supplies).
const flowKey = security.mintApiKey('Power Automate', 'flow');
out.apiKeys.push({ scope: 'flow', key: flowKey });

console.log('\n=== Seed complete ===\n');
console.log('Print host secrets (put in each agent .env as PP_HMAC_SECRET):');
for (const h of out.hosts) console.log(`  ${h.code}  ${h.hmacSecret}   [${h.note}]`);
console.log('\nPower Automate API key (X-API-Key header, shown once):');
for (const k of out.apiKeys) console.log(`  ${k.key}`);
console.log('\nPrinters:');
for (const p of q.all('SELECT code, display_name, roll_width_in FROM printers ORDER BY sort_order')) {
  console.log(`  ${p.code.padEnd(24)} ${p.roll_width_in}"  ${p.display_name}`);
}
console.log('\nSign in once at the portal, then run:');
console.log('  sqlite3 $DB_PATH "UPDATE users SET role=\'admin\' WHERE email=\'you@kent.edu\'"');
console.log('(or set BOOTSTRAP_ADMINS in .env before your first login)\n');
