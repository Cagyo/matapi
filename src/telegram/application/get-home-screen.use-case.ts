import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  type SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import type { HomeView } from '../domain/home-session';
import type { Role } from '../domain/role';
import { GetHomeSummaryUseCase } from './get-home-summary.use-case';
import type { HomeScreen } from './home-screen';

export interface GetHomeScreenInput {
  userId: number;
  role: Role;
  view: HomeView;
}

@Injectable()
export class GetHomeScreenUseCase {
  constructor(
    private readonly summary: GetHomeSummaryUseCase,
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
  ) {}

  async execute(input: GetHomeScreenInput): Promise<HomeScreen> {
    const summary = await this.summary.execute(input.userId);
    if (input.view.kind === 'home') {
      return { kind: 'home', summary, checking: input.view.checking };
    }

    const page = await this.sensors.listDashboardPage({
      page: input.view.page,
      pageSize: 8,
    });
    return {
      kind: 'sensors',
      summary,
      page,
      checking: input.view.checking,
      isAdmin: input.role === 'admin',
    };
  }
}
