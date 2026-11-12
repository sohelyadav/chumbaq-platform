import { memo, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GeoPoint } from '@/hooks/use-analytics';
import { useTheme } from '@/hooks/use-theme';

interface GeoMapProps {
  points: GeoPoint[];
}

const SAMPLE_POINTS: GeoPoint[] = [
  { lat: 19.076, lng: 72.877, city: 'Mumbai', country: 'IN', count: 42 },
  { lat: 28.613, lng: 77.209, city: 'Delhi', country: 'IN', count: 35 },
  { lat: 40.712, lng: -74.006, city: 'New York', country: 'US', count: 28 },
  { lat: 51.507, lng: -0.127, city: 'London', country: 'GB', count: 22 },
  { lat: 35.689, lng: 139.691, city: 'Tokyo', country: 'JP', count: 18 },
  { lat: -33.868, lng: 151.209, city: 'Sydney', country: 'AU', count: 12 },
  { lat: 1.352, lng: 103.819, city: 'Singapore', country: 'SG', count: 15 },
  { lat: 48.856, lng: 2.352, city: 'Paris', country: 'FR', count: 10 },
  { lat: 55.755, lng: 37.617, city: 'Moscow', country: 'RU', count: 8 },
  { lat: -23.550, lng: -46.633, city: 'São Paulo', country: 'BR', count: 14 },
  { lat: 12.971, lng: 77.594, city: 'Bangalore', country: 'IN', count: 30 },
  { lat: 37.774, lng: -122.419, city: 'San Francisco', country: 'US', count: 20 },
];

function GeoMapInner({ points }: GeoMapProps) {
  const { accent, theme } = useTheme();
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);

  const displayPoints = points && points.length > 0 ? points : SAMPLE_POINTS;
  const isSample = !points || points.length === 0;

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, {
      center: [20, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 10,
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: true,
    });

    L.tileLayer('https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}{r}.png', {
      minZoom: 0,
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    L.control.zoom({ position: 'topleft' }).addTo(map);

    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    leafletMap.current = map;

    return () => {
      map.remove();
      leafletMap.current = null;
    };
  }, []);

  // Update markers when points change
  useEffect(() => {
    const map = leafletMap.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();

    const maxCount = Math.max(...displayPoints.map((p) => p.count));
    const style = getComputedStyle(document.documentElement);
    const heatColors = [
      style.getPropertyValue('--chart-5').trim() || '#a3a3a3',
      style.getPropertyValue('--chart-4').trim() || '#737373',
      style.getPropertyValue('--chart-3').trim() || '#525252',
      style.getPropertyValue('--chart-2').trim() || '#404040',
      style.getPropertyValue('--chart-1').trim() || '#171717',
    ];

    displayPoints.forEach((point) => {
      const normalized = Math.max(0.2, point.count / maxCount);
      const radius = 6 + normalized * 18;
      const heatIdx = Math.min(heatColors.length - 1, Math.floor(normalized * (heatColors.length - 1)));
      const color = heatColors[heatIdx];

      // Pulsing circle marker
      const marker = L.circleMarker([point.lat, point.lng], {
        radius,
        fillColor: color,
        fillOpacity: 0.2 + normalized * 0.4,
        color,
        weight: 1.5,
        opacity: 0.6,
      });

      // Tooltip
      marker.bindTooltip(
        `<div style="text-align:center;font-size:12px;">
          <strong>${point.city || 'Unknown'}</strong><br/>
          <span style="color:var(--muted-foreground);">${point.country}</span><br/>
          <strong>${point.count}</strong> click${point.count !== 1 ? 's' : ''}
        </div>`,
        { direction: 'top', offset: [0, -radius], className: 'geo-tooltip' }
      );

      marker.addTo(markers);
    });

    // Fit bounds to show all points
    if (displayPoints.length > 0) {
      const bounds = L.latLngBounds(displayPoints.map((p) => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 5 });
    }
  }, [displayPoints, accent, theme]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg">
      <div ref={mapRef} className="w-full" style={{ height: 'calc(100svh - 12rem)' }} />
      {isSample && (
        <div className="absolute top-2 right-2 text-[10px] text-amber-500 bg-background/80 backdrop-blur-sm rounded px-2 py-1 border z-[1000]">
          Sample data
        </div>
      )}
      <style>{`
        .geo-tooltip {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 6px 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          color: var(--foreground);
        }
        .geo-tooltip::before {
          border-top-color: var(--border) !important;
        }
        .leaflet-control-zoom a {
          background: var(--card) !important;
          color: var(--foreground) !important;
          border-color: var(--border) !important;
        }
        .leaflet-control-zoom a:hover {
          background: var(--accent) !important;
        }
      `}</style>
    </div>
  );
}

export const GeoMap = memo(GeoMapInner);
