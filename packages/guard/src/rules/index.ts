import type { RuleId } from '../types.ts';
import type { Rule } from './context.ts';
import { eg012, eg013 } from './audience.ts';
import { eg001, eg009 } from './conversions.ts';
import { eg002, eg008 } from './exposures.ts';
import { eg007, eg011 } from './identity.ts';
import { eg003, eg004, eg010 } from './sdk.ts';
import { eg005, eg006 } from './treatment.ts';

export const RULE_IMPLS: Record<RuleId, Rule> = {
  EG001: eg001,
  EG002: eg002,
  EG003: eg003,
  EG004: eg004,
  EG005: eg005,
  EG006: eg006,
  EG007: eg007,
  EG008: eg008,
  EG009: eg009,
  EG010: eg010,
  EG011: eg011,
  EG012: eg012,
  EG013: eg013,
};

export { RULES, RULES_BY_ID, type RuleMeta } from './catalog.ts';
export type { RawFinding, Rule, RuleContext } from './context.ts';
