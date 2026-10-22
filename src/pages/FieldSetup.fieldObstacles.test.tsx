import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FieldSetup from './FieldSetup';

const {
  mockCheckMutationResult,
  mockDrawLayer,
  mockFrom,
  mockInsert,
  mockRpc,
  mockToast,
  mockUseAuth,
  mockUseParams,
} = vi.hoisted(() => ({
  mockCheckMutationResult: vi.fn(),
  mockDrawLayer: vi.fn(),
  mockFrom: vi.fn(),
  mockInsert: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseParams: vi.fn(),
}));

// A ~40 ac square near the test field, shaped like DrawLayer's DrawnPolygon.
const mockDrawnPolygon = {
  drawId: 'draw-1',
  acres: 40,
  label: 'Part 1',
  polygon: {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[-89.05, 39.15], [-89.0475, 39.15], [-89.0475, 39.1523], [-89.05, 39.1523], [-89.05, 39.15]]],
    },
  },
};

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => mockUseParams(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  checkMutationResult: mockCheckMutationResult,
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/fieldsGeojsonCache', () => ({
  getCachedFieldsGeojson: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/plssLookup', () => ({
  lookupPlss: vi.fn(),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key', resetKey: vi.fn() }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));

vi.mock('../components/map/CRXMap', () => ({
  default: ({
    children,
    onMapClick,
  }: {
    children: ReactNode;
    onMapClick?: (longitude: number, latitude: number) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onMapClick?.(-89.04, 39.16)}>Mock map click</button>
      {children}
    </div>
  ),
}));

vi.mock('../components/map/DrawLayer', () => ({
  default: ({
    disabled = false,
    allowRemoveSinglePart = false,
    onDrawingStateChange,
    onPolygonsChange,
  }: {
    disabled?: boolean;
    allowRemoveSinglePart?: boolean;
    onDrawingStateChange?: (isDrawing: boolean) => void;
    onPolygonsChange?: (polygons: unknown[]) => void;
  }) => {
    mockDrawLayer({ disabled, allowRemoveSinglePart, onDrawingStateChange });
    return (
      <>
        <button
          type="button"
          data-testid="mock-draw-layer"
          onClick={() => onDrawingStateChange?.(true)}
        >
          Start mock boundary drawing
        </button>
        <button type="button" onClick={() => onPolygonsChange?.([mockDrawnPolygon])}>
          Commit mock boundary
        </button>
      </>
    );
  },
}));
vi.mock('../components/map/AddressSearch', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../components/map/FieldObstacleLayer', () => ({ default: () => null }));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));
vi.mock('../components/ui/ConfirmModal', () => ({
  default: ({
    open,
    onConfirm,
    confirmLabel = 'Confirm',
  }: {
    open: boolean;
    onConfirm: () => void;
    confirmLabel?: string;
  }) => open ? <button type="button" onClick={onConfirm}>{confirmLabel}</button> : null,
}));

const savedObstacle = {
  id: 'obstacle-1',
  field_id: 'field-1',
  kind: 'oil_well',
  label: 'West well',
  point_geojson: { type: 'Point', coordinates: [-89.05, 39.15] },
  created_by: 'user-1',
  created_at: '2026-07-11T12:00:00Z',
  updated_at: '2026-07-11T12:00:00Z',
};

const insertedObstacle = {
  ...savedObstacle,
  id: 'obstacle-2',
  kind: 'windmill',
  label: 'North windmill',
  point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
};

function listChain(data: unknown, error: unknown = null): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = (resolve: (result: { data: unknown; error: unknown }) => void) => resolve({ data, error });
  return chain;
}

// Every customers query the page builds (only the owner/split search pickers read customers).
const customerChains: Array<Record<string, unknown>> = [];

function configureSupabase(obstacleReadError: unknown = null, measuredAcres: number | null = null): void {
  customerChains.length = 0;
  mockRpc.mockImplementation((name: string) => {
    if (name === 'get_field_geojson' || name === 'get_field_polygons') {
      return Promise.resolve({ data: [], error: null });
    }
    if (name === 'set_field_boundary') {
      // Shape of the RPC's v_result (migration 20260623130000).
      return Promise.resolve({
        data: { field_id: 'field-1', measured_acres: 40, billable_acres: 40, acres_source: 'measured' },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'fields') {
      return {
        select: () => ({
          eq: () => ({
            // Duplicate-name check run when an owner is picked.
            ilike: () => ({ neq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
            maybeSingle: () => Promise.resolve({
              data: {
                id: 'field-1',
                customer_id: 'customer-1',
                field_name: 'North 40',
                state: 'IL',
                total_acres: 40,
                measured_acres: measuredAcres,
                override_acres: null,
                irrigation: false,
                is_active: true,
                customer: { farm_name: 'Smith Farm' },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'customers') {
      const chain = listChain([{ id: 'customer-2', farm_name: 'Jones Farm', is_active: true }]);
      customerChains.push(chain);
      return chain;
    }
    if (table === 'field_billing_defaults') {
      return listChain([]);
    }
    if (table === 'field_obstacles') {
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({
              data: obstacleReadError ? null : [savedObstacle],
              error: obstacleReadError,
            }),
          }),
        }),
        insert: (payload: unknown) => {
          mockInsert(payload);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: insertedObstacle, error: null }),
            }),
          };
        },
        delete: () => ({
          eq: (_column: string, id: string) => ({
            select: () => Promise.resolve({ data: [{ id }], error: null }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('FieldSetup field obstacles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ id: 'field-1' });
    mockUseAuth.mockReturnValue({ profile: { id: 'user-1', role: 'admin' } });
    configureSupabase();
  });

  it('loads, adds, and confirms deletion of obstacle pins', async () => {
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));
    expect(screen.getByText('Click the map where the obstacle is located.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    fireEvent.change(screen.getByLabelText('Obstacle type'), { target: { value: 'windmill' } });
    fireEvent.change(screen.getByLabelText('Obstacle label (optional)'), { target: { value: 'North windmill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save obstacle' }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalledWith({
      field_id: 'field-1',
      kind: 'windmill',
      label: 'North windmill',
      point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
      created_by: 'user-1',
    }));
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ data: insertedObstacle, error: null }),
      'Add field obstacle',
    );
    expect(await screen.findByText(/North windmill/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete obstacle North windmill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete obstacle' }));

    await waitFor(() => expect(screen.queryByText(/North windmill/)).not.toBeInTheDocument());
    expect(mockCheckMutationResult).toHaveBeenLastCalledWith(
      { data: [{ id: 'obstacle-2' }], error: null },
      'Delete field obstacle',
    );
  });

  it('shows an empty section and toast when the obstacle read fails', async () => {
    configureSupabase(new Error('read failed'));
    render(<FieldSetup />);

    expect(await screen.findByText('No obstacles marked for this field.')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'Could not load field obstacles.');
  });

  it('keeps the draw layer mounted and blocks obstacle mode during an active boundary sketch', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel obstacle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start mock boundary drawing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));

    expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Finish or cancel the boundary before adding an obstacle.',
    );
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false }));
  });

  it('lets a field without a saved boundary remove its only drawn part', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ allowRemoveSinglePart: true }));
  });

  it('keeps a saved measured boundary from being removed down to nothing', async () => {
    // Render state, not a ref read during render, drives this prop (React 19 follow-up, 2026-10-14).
    configureSupabase(null, 38.5);
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    await waitFor(() => expect(mockDrawLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRemoveSinglePart: false }),
    ));
  });

  it('stops offering single-part removal once a newly drawn boundary is saved', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ allowRemoveSinglePart: true }));
    // FieldSetup marks geometry dirty only after its post-load tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Commit mock boundary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_field_boundary', expect.anything()));
    await waitFor(() => expect(mockDrawLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRemoveSinglePart: false }),
    ));
  });

  it('loads no customer list and finds the owner by searching active customers', async () => {
    render(<FieldSetup />);

    const owner = await screen.findByRole('combobox', { name: 'Owner (Customer)' });
    expect(owner).toHaveValue('Smith Farm');
    expect(customerChains).toHaveLength(0);

    fireEvent.focus(owner);
    fireEvent.change(owner, { target: { value: 'Jon' } });
    fireEvent.click(await screen.findByText('Jones Farm'));

    expect(owner).toHaveValue('Jones Farm');
    expect(customerChains).toHaveLength(1);
    expect(customerChains[0].eq).toHaveBeenCalledWith('is_active', true);
    expect(customerChains[0].limit).toHaveBeenCalled();
  });

  it('keeps obstacle write controls hidden from applicators', async () => {
    mockUseAuth.mockReturnValue({ profile: { id: 'applicator-1', role: 'applicator' } });
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add obstacle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete obstacle West well' })).not.toBeInTheDocument();
  });
});
