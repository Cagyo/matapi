import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { DevSeederService, SeedResult } from '../application/dev-seeder.service';
import { SimulateSensorUseCase } from '../application/simulate-sensor.use-case';
import { SensorNotSimulatableError } from '../domain/errors/sensor-not-simulatable.error';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';
import { Sensor } from '../domain/sensor';

interface SimulateAck {
  ok: true;
  id: string;
  value: number;
}

const CO2_MIN = 400;
const CO2_MAX = 2000;

/**
 * Dev-only web panel (spec 26 § Mock GPIO Simulator).
 *
 * Mounted on the worker's loopback HTTP server only when
 * `NODE_ENV=development` — see `SensorModule`. `GET /dev/simulate` serves a
 * self-contained control panel; the POST routes push readings into the live
 * mock drivers, firing the same pipeline as real hardware.
 */
@Controller('dev/simulate')
export class DevSimulatorController {
  private readonly logger = new Logger(DevSimulatorController.name);

  constructor(
    private readonly simulate: SimulateSensorUseCase,
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly devSeeder: DevSeederService,
  ) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  async panel(): Promise<string> {
    const sensors = await this.sensors.listEnabled();
    return renderPanel(sensors);
  }

  @Post('seed')
  async seed(@Body() body: { reset?: unknown }): Promise<SeedResult> {
    return this.devSeeder.seed({ reset: body?.reset !== false });
  }

  @Post('digital')
  digital(@Body() body: { id?: string; value?: unknown }): SimulateAck {
    const id = requireId(body.id);
    const value = Number(body.value) >= 1 ? 1 : 0;
    this.run(id, value);
    return { ok: true, id, value };
  }

  @Post('co2')
  co2(@Body() body: { id?: string; ppm?: unknown }): SimulateAck {
    const id = requireId(body.id);
    const ppm = clampPpm(Number(body.ppm));
    this.run(id, ppm);
    return { ok: true, id, value: ppm };
  }

  private run(id: string, value: number): void {
    try {
      this.simulate.execute(id, value);
    } catch (error) {
      if (error instanceof SensorNotSimulatableError) {
        throw new BadRequestException(error.message);
      }
      this.logger.warn(`simulate failed for ${id}: ${(error as Error).message}`);
      throw error;
    }
  }
}

function requireId(id: string | undefined): string {
  if (!id || typeof id !== 'string') {
    throw new BadRequestException('sensor id is required');
  }
  return id;
}

function clampPpm(ppm: number): number {
  if (Number.isNaN(ppm)) return CO2_MIN;
  return Math.min(CO2_MAX, Math.max(CO2_MIN, Math.round(ppm)));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pinLabel(config: Record<string, unknown>): string {
  const pin = config.pin;
  return typeof pin === 'number' ? `GPIO ${pin}` : '—';
}

function renderRow(sensor: Sensor): string {
  const id = escapeHtml(sensor.id);
  const name = escapeHtml(sensor.name);
  if (sensor.type === 'digital') {
    return `
      <div class="row" data-id="${id}">
        <span class="label">${name} <small>(${escapeHtml(pinLabel(sensor.config))})</small></span>
        <span class="state" id="state-${id}">—</span>
        <span class="controls">
          <button onclick="setDigital('${id}', 1)">ON</button>
          <button class="off" onclick="setDigital('${id}', 0)">OFF</button>
        </span>
      </div>`;
  }
  if (sensor.type === 'uart') {
    return `
      <div class="row" data-id="${id}">
        <span class="label">${name} <small>(CO₂ / UART)</small></span>
        <span class="state" id="state-${id}">— ppm</span>
        <span class="controls">
          <input type="range" min="${CO2_MIN}" max="${CO2_MAX}" value="${CO2_MIN}"
                 oninput="setCo2('${id}', this.value)" />
        </span>
      </div>`;
  }
  return '';
}

function renderPanel(sensors: Sensor[]): string {
  const simulatable = sensors.filter(
    (s) => s.type === 'digital' || s.type === 'uart',
  );
  const rows = simulatable.map(renderRow).join('\n');
  const empty =
    '<p class="empty">No simulatable sensors configured. Add a digital or UART sensor via the bot, then reload.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Home Worker — Dev Simulator</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, sans-serif; background: #11151a; color: #e6e6e6; margin: 0; padding: 2rem; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; max-width: 640px; margin-bottom: 1.5rem; }
    h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
    p.sub { color: #8a949e; margin: 0; }
    .panel { max-width: 640px; border: 1px solid #2a313a; border-radius: 12px; overflow: hidden; }
    .row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 1rem; padding: .85rem 1.1rem; border-bottom: 1px solid #20262e; }
    .row:last-child { border-bottom: 0; }
    .label small { color: #8a949e; }
    .state { min-width: 5.5rem; text-align: center; font-variant-numeric: tabular-nums; color: #9ad; }
    button { cursor: pointer; border: 0; border-radius: 8px; padding: .4rem .9rem; font-weight: 600; background: #2e7d32; color: #fff; }
    button.off { background: #5a3030; }
    button.reset { background: #1976d2; }
    button:hover { filter: brightness(1.15); }
    input[type=range] { width: 220px; }
    .empty { color: #8a949e; padding: 1.5rem 1.1rem; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Home Worker — Dev Simulator</h1>
      <p class="sub">NODE_ENV=development · drives the same pipeline as real GPIO/UART.</p>
    </div>
    <button class="reset" onclick="resetDevState()">Reset Dev State</button>
  </div>
  <div class="panel">
    ${rows || empty}
  </div>
  <script>
    async function resetDevState() {
      try {
        const res = await fetch('/dev/simulate/seed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reset: true }),
        });
        if (!res.ok) throw new Error(await res.text());
        location.reload();
      } catch (err) {
        alert('Failed to reset dev state: ' + err.message);
      }
    }
    async function post(path, payload, id, render) {
      const el = document.getElementById('state-' + id);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (el) el.textContent = render(data.value);
      } catch (err) {
        if (el) el.textContent = 'error';
        console.error(err);
      }
    }
    function setDigital(id, value) {
      post('/dev/simulate/digital', { id: id, value: value }, id, (v) => (v ? 'ON' : 'OFF'));
    }
    function setCo2(id, ppm) {
      post('/dev/simulate/co2', { id: id, ppm: Number(ppm) }, id, (v) => v + ' ppm');
    }
  </script>
</body>
</html>`;
}
