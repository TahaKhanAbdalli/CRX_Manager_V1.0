import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockProfile = vi.fn();
const mockDeniedPages = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: mockProfile(),
    deniedPages: mockDeniedPages(),
  }),
}));

// Only the deny-list lookup is stubbed; canManageInvoices is the real admin-only rule.
vi.mock('../../lib/pagePermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/pagePermissions')>()),
  hasPageAccess: vi.fn(() => true),
}));

vi.mock('../team/NotificationsPanel', () => ({
  default: () => (
    <div>
      <button type="button" aria-label="Notifications">Notifications</button>
    </div>
  ),
}));

import TopBar from './TopBar';

function renderTopBar() {
  const onMenuClick = vi.fn();
  const onSearchClick = vi.fn();
  render(
    <MemoryRouter>
      <TopBar
        onMenuClick={onMenuClick}
        onSearchClick={onSearchClick}
        title="A long operations title that needs to fit on a phone"
        accent="Today"
      />
    </MemoryRouter>
  );
  return { onMenuClick, onSearchClick };
}

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    mockDeniedPages.mockReturnValue([]);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  });

  it('uses a compact mobile bar while preserving the desktop dimensions', () => {
    renderTopBar();

    const bar = screen.getByRole('banner').firstElementChild;
    expect(bar).toHaveClass('h-14', 'px-2.5', 'md:h-16', 'md:px-4', 'lg:px-6');
    expect(screen.getByRole('heading')).toHaveClass('truncate', 'text-lg', 'md:text-xl');
  });

  it('keeps menu, search, and notifications reachable with 44px touch targets', () => {
    const { onMenuClick, onSearchClick } = renderTopBar();

    const menu = screen.getByRole('button', { name: 'Open navigation menu' });
    const search = screen.getByRole('button', { name: 'Search (Ctrl+K)' });
    const notifications = screen.getByRole('button', { name: 'Notifications' });

    expect(menu).toHaveClass('min-h-11', 'min-w-11');
    expect(search).toHaveClass('min-h-11', 'min-w-11');
    expect(notifications.parentElement?.parentElement).toHaveClass(
      '[&>div>button]:min-h-11',
      '[&>div>button]:min-w-11'
    );

    fireEvent.click(menu);
    fireEvent.click(search);
    expect(onMenuClick).toHaveBeenCalledOnce();
    expect(onSearchClick).toHaveBeenCalledOnce();
  });

  it('hides the non-essential create action below md while keeping it on desktop', () => {
    renderTopBar();

    expect(screen.getByRole('button', { name: /new/i }).parentElement).toHaveClass('hidden', 'md:block');
  });

  // Invoicing is admin-only (Mason 2026-10-09): the New menu's Field App Invoice entry
  // creates an invoice, so a sales rep no longer sees it (its route is admin-only too).
  it('offers Field App Invoice in the New menu to an admin', () => {
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    expect(screen.getByRole('menuitem', { name: 'Field App Invoice' })).toBeInTheDocument();
  });

  it('keeps the rest of the New menu for a sales rep but drops Field App Invoice', () => {
    mockProfile.mockReturnValue({ id: '2', role: 'sales_rep', full_name: 'Sales Rep' });
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    expect(screen.getByRole('menuitem', { name: 'Order' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Field App Invoice' })).not.toBeInTheDocument();
  });
});
