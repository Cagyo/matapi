import { Injectable } from '@nestjs/common';
import { parse, stringify } from 'yaml';
import { ConfigSnapshot } from '../domain/config-snapshot';
import { ConfigCodecPort } from '../domain/ports/config-codec.port';

/** YAML implementation of `ConfigCodecPort` (spec 16). */
@Injectable()
export class YamlConfigCodec implements ConfigCodecPort {
  serialize(snapshot: ConfigSnapshot): string {
    return stringify(snapshot);
  }

  parse(text: string): unknown {
    return parse(text);
  }
}
