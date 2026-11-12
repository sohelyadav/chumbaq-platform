import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { useLinkGeo } from '@/hooks/use-analytics';
import { GeoMap } from '@/components/analytics/geo-map';

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  US: 'US',
  USA: 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  IN: 'IN',
  INDIA: 'IN',
};

const REGION_NAME_BY_COUNTRY: Record<string, Record<string, string>> = {
  US: {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
  },
  IN: {
    AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh',
    GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JH: 'Jharkhand',
    KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
    ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', PB: 'Punjab', RJ: 'Rajasthan',
    SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TR: 'Tripura', UK: 'Uttarakhand',
    UP: 'Uttar Pradesh', WB: 'West Bengal', AN: 'Andaman and Nicobar Islands', CH: 'Chandigarh',
    DN: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi', JK: 'Jammu and Kashmir',
    LA: 'Ladakh', LD: 'Lakshadweep', PY: 'Puducherry',
  },
};

function normalizeCountryCode(country: string): string {
  const normalized = country.trim().toUpperCase();
  return COUNTRY_CODE_ALIASES[normalized] || normalized;
}

function getRegionDisplayName(region: string, country: string): string {
  const cleanRegion = region.trim();
  if (!cleanRegion) return 'Unknown';

  const countryCode = normalizeCountryCode(country);
  const regionCode = cleanRegion.toUpperCase();
  const mapped = REGION_NAME_BY_COUNTRY[countryCode]?.[regionCode];

  if (mapped) return mapped;
  return cleanRegion;
}

interface GeoTableProps {
  linkId: string;
}

export function GeoTable({ linkId }: GeoTableProps) {
  const { data, isLoading } = useLinkGeo(linkId);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded bg-muted" />;
  }

  if (!data || (data.countries.length === 0 && data.cities.length === 0)) {
    return (
      <div className="h-40 flex items-center justify-center text-muted-foreground">
        No geographic data available
      </div>
    );
  }

  const statesMap = new Map<string, { region: string; country: string; count: number }>();
  for (const city of data.cities) {
    const region = city.region?.trim() || 'Unknown';
    const country = normalizeCountryCode(city.country?.trim() || '');
    const key = `${region.toUpperCase()}|${country}`;
    const existing = statesMap.get(key);
    if (existing) {
      existing.count += city.count;
    } else {
      statesMap.set(key, { region, country, count: city.count });
    }
  }

  const states = Array.from(statesMap.values()).sort((a, b) => b.count - a.count);
  const total = states.reduce((sum, s) => sum + s.count, 0);

  if (states.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-[3fr_2fr] md:items-start">
        <div className="md:order-1">
          <GeoMap points={data.points || []} />
        </div>
        <div className="md:order-2 h-full min-h-40 rounded-lg border flex items-center justify-center text-muted-foreground px-4 text-center">
          No state-level data available yet
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[3fr_2fr] md:items-start">
      {/* Heat map */}
      <div className="md:order-1">
        <GeoMap points={data.points || []} />
      </div>

      {/* State table */}
      <div className="md:order-2 relative w-full overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {states.map((entry, index) => (
              <TableRow key={`${entry.region}-${entry.country || index}`}>
                <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-medium">
                  {getRegionDisplayName(entry.region, entry.country)}
                  {entry.country && (
                    <span className="ml-2 text-muted-foreground text-xs">{entry.region.toUpperCase()} • {entry.country}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{entry.count.toLocaleString()}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {total > 0 ? ((entry.count / total) * 100).toFixed(1) : 0}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
