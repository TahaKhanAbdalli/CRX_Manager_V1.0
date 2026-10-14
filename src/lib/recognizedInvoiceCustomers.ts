import { supabase } from './db';

const PAGE_SIZE = 1000;

export interface RecognizedInvoiceCustomerRow {
  id: string;
  customer_id: string | null;
}

type FetchRecognizedInvoicePage = (
  from: number,
  to: number,
) => Promise<RecognizedInvoiceCustomerRow[]>;

export async function collectRecognizedInvoiceCustomerIds(
  fetchPage: FetchRecognizedInvoicePage,
): Promise<string[]> {
  const customerIds = new Set<string>();

  for (let from = 0; ;) {
    const rows = await fetchPage(from, from + PAGE_SIZE - 1);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.customer_id) customerIds.add(row.customer_id);
    }
    // Advance by what the server actually returned. This remains complete if
    // its configured row cap is lower than our requested page size.
    from += rows.length;
  }

  return [...customerIds];
}

export async function getRecognizedInvoiceCustomerIds(season: number): Promise<string[]> {
  return collectRecognizedInvoiceCustomerIds(async (from, to) => {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, customer_id')
      .eq('season', season)
      .in('status', ['posted', 'overdue', 'paid'])
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data || [];
  });
}
