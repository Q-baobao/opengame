// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attributedEntryId, PRODUCT_ID } from '../../../../shared/product-identity';
import { validProperties } from '../../../../tracking/core.ts';
import { studioEvents } from '../../../../tracking/events.ts';
import { I18nProvider } from '../../i18n/I18n';
import { campaignPricingUrl } from '../campaignAttribution';
import {
  closeMonetizationGate,
  detectMonetizationGateFromError,
  openBalanceGate,
  openConcurrencyGate,
  readPreviewGateFromSearch,
} from './monetizationGateBus';
import { MonetizationGateModal } from './MonetizationGateModal';
import { trackMotion } from '../tracking';

vi.mock('../tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('../gatewayClient', () => ({
  gatewayRequest: vi.fn(async () => ({ state: 'signed-in', plan: 'free', balance: '0.00' })),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tracked = () => vi.mocked(trackMotion).mock.calls.map(([event, properties]) => ({
  event,
  properties: properties as Record<string, unknown>,
}));

describe('OpenGame monetization attribution & gate hooks', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.mocked(trackMotion).mockClear();
    closeMonetizationGate();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    closeMonetizationGate();
  });

  it('prefixes checkout entry ids with opengame- without double prefixing', () => {
    expect(PRODUCT_ID).toBe('opengame');
    expect(attributedEntryId('abc-123')).toBe('opengame-abc-123');
    expect(attributedEntryId('opengame-abc-123')).toBe('opengame-abc-123');
    const url = new URL(campaignPricingUrl('zh-CN', 'opengame_balance_gate', '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11'));
    expect(url.searchParams.get('od_entry_id')).toBe('opengame-7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11');
    expect(url.searchParams.get('utm_source')).toBe('opengame');
    expect(url.searchParams.get('utm_medium')).toBe('balance_gate');
    expect(url.searchParams.get('od_origin')).toBe('openmotion');
    expect(url.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
  });

  it('classifies balance and concurrency errors while ignoring 503 outages', () => {
    expect(detectMonetizationGateFromError({ status: 402 })).toMatchObject({ kind: 'balance', reason: 'insufficient_balance' });
    expect(detectMonetizationGateFromError({ code: 'quota_exceeded' })).toMatchObject({ kind: 'balance', reason: 'quota_exceeded' });
    expect(detectMonetizationGateFromError({ code: 'concurrency_limit' })).toMatchObject({ kind: 'concurrency', reason: 'concurrency_limit' });
    expect(detectMonetizationGateFromError({ status: 503, message: 'insufficient balance' })).toBeNull();
    expect(detectMonetizationGateFromError({ status: 502, message: 'Bad Gateway' })).toBeNull();
    expect(readPreviewGateFromSearch('?previewGate=balance')).toMatchObject({ kind: 'balance' });
    expect(readPreviewGateFromSearch('?previewGate=concurrency')).toMatchObject({ kind: 'concurrency' });
    expect(readPreviewGateFromSearch('?mode=game')).toBeNull();
  });

  it('validates all new OpenGame monetization tracking events against the closed schema', () => {
    const id = '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11';
    for (const [event, props] of [
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'modal', hook_id: 'balance_gate_topup', entry_id: id, studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'open_pricing', hook_id: 'balance_gate_topup', entry_id: id, studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'check_balance', hook_id: 'concurrency_gate_upgrade', entry_id: id, studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_panel_signin', publish_target: 'game', studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'open_pricing', hook_id: 'game_publish_unlisted_upgrade', entry_id: id, publish_target: 'game', studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'growth_surface', element: 'referral_card', hook_id: 'referral_invite_card', entry_id: id, studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'growth_surface', element: 'copy_referral_link', hook_id: 'referral_invite_card', entry_id: id, studio_id: 'game' }],
    ] as const) {
      expect(validProperties(studioEvents, event, props)).toBe(true);
    }
  });

  it('renders BalanceGateDialog, tracks impression & CTA click, and enters 5s polling state', async () => {
    await act(async () => {
      root.render(<I18nProvider initialLocale="zh-CN"><MonetizationGateModal /></I18nProvider>);
    });
    expect(document.querySelector('[data-testid="balance-gate-dialog"]')).toBeNull();

    await act(async () => {
      openBalanceGate({ reason: 'insufficient_balance' });
    });

    const dialog = document.querySelector('[data-testid="balance-gate-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('需要补充额度以继续');

    const impression = tracked().find(item => item.event === 'surface_view');
    expect(impression?.properties).toMatchObject({
      page_name: 'creative_studio',
      area: 'entitlement_modal',
      element: 'modal',
      hook_id: 'balance_gate_topup',
      studio_id: 'game',
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    const url = new URL(cta.href);
    expect(url.searchParams.get('utm_source')).toBe('opengame');
    expect(url.searchParams.get('od_entry_id')).toBe(`opengame-${impression!.properties.entry_id}`);

    await act(async () => {
      cta.click();
    });
    expect(document.querySelector('[data-testid="monetization-gate-polling"]')).not.toBeNull();
    expect(tracked().some(item => item.event === 'ui_click' && item.properties.element === 'open_pricing' && item.properties.hook_id === 'balance_gate_topup')).toBe(true);
  });

  it('renders ConcurrencyGateDialog with counts and tracks dismiss', async () => {
    await act(async () => {
      root.render(<I18nProvider initialLocale="zh-CN"><MonetizationGateModal /></I18nProvider>);
      openConcurrencyGate({ activeCount: 2, limitCount: 2 });
    });

    const dialog = document.querySelector('[data-testid="concurrency-gate-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('2/2');

    const closeBtn = dialog!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
      ?? dialog!.querySelector<HTMLButtonElement>('.om-mg-close')!;
    await act(async () => {
      closeBtn.click();
    });
    expect(document.querySelector('[data-testid="concurrency-gate-dialog"]')).toBeNull();
    expect(tracked().some(item => item.event === 'ui_click' && item.properties.element === 'close_modal' && item.properties.hook_id === 'concurrency_gate_upgrade')).toBe(true);
  });

  it('recognizes ?previewGate=resolution and routes 2K/4K gate with studio_res_gate attribution', async () => {
    const preview = readPreviewGateFromSearch('?previewGate=resolution');
    expect(preview).toMatchObject({ kind: 'resolution', resolutionLabel: '4K' });
    const url = new URL(campaignPricingUrl('zh-CN', 'opengame_resolution_gate', '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11'));
    expect(url.searchParams.get('utm_source')).toBe('opengame');
    expect(url.searchParams.get('utm_medium')).toBe('resolution_gate');
    expect(url.searchParams.get('od_entry_id')).toBe('opengame-7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11');
  });
});
