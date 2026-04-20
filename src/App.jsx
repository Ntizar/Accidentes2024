import { startTransition, useDeferredValue, useEffect, useState } from 'react'
import { geoMercator, geoPath } from 'd3-geo'

const ROAD_LABELS = {
  motorway: 'Autopista',
  dual_carriageway: 'Autovia',
  conventional: 'Via convencional',
  rural_lane: 'Camino vecinal',
  service_road: 'Via de servicio',
  link_road: 'Ramal de enlace',
  other: 'Otro tipo',
  street: 'Calle',
  crossing: 'Travesia',
}

const VEHICLE_LABELS = {
  bicycle: 'Bicicleta',
  vmp: 'VMP',
  cyclomotor: 'Ciclomotor',
  motorcycle: 'Motocicleta',
  tourism: 'Turismo',
  van: 'Furgoneta',
  truckUpTo3500: 'Camion hasta 3.500 kg',
}

const NAV_ITEMS = [
  { href: '#overview', label: 'Panorama' },
  { href: '#mapa', label: 'Mapa' },
  { href: '#ritmo', label: 'Ritmo' },
  { href: '#victimas', label: 'Victimas' },
  { href: '#riesgo', label: 'Riesgo' },
  { href: '#tablas', label: 'Tablas' },
]

const AURORA_STOPS = ['#edf4ff', '#c9dcff', '#7fa7ff', '#356fe5']
const CANARY_PROVINCES = new Set(['las palmas', 'santa cruz de tenerife'])

const MAP_METRICS = {
  accidents: {
    label: 'Accidentes',
    description: 'Intensidad territorial del total de accidentes con victimas por provincia.',
    getValueFromProvince: (province) => province.total.accidents,
    getValueFromFeature: (properties) => properties.totalAccidents,
    format: (value) => formatCompact(value),
    shortLabel: 'accidentes',
  },
  fatalities: {
    label: 'Fallecidos',
    description: 'Concentracion de fallecidos por provincia durante 2024.',
    getValueFromProvince: (province) => province.total.fatalities,
    getValueFromFeature: (properties) => properties.totalFatalities,
    format: (value) => formatNumber(value),
    shortLabel: 'fallecidos',
  },
  urbanShare: {
    label: 'Peso urbano',
    description: 'Porcentaje del total provincial que ocurre en vias urbanas.',
    getValueFromProvince: (province) => percentage(province.urban.accidents, province.total.accidents),
    getValueFromFeature: (properties) => percentage(properties.urbanAccidents, properties.totalAccidents),
    format: (value) => formatPercent(value, 1),
    shortLabel: 'urbano',
  },
  fatalityRate: {
    label: 'Severidad',
    description: 'Fallecidos por cada 100 accidentes con victimas.',
    getValueFromProvince: (province) => percentage(province.total.fatalities, province.total.accidents),
    getValueFromFeature: (properties) => percentage(properties.totalFatalities, properties.totalAccidents),
    format: (value) => `${value.toFixed(1)} / 100`,
    shortLabel: 'severidad',
  },
}

const TREND_METRICS = {
  accidents: {
    label: 'Accidentes con victimas',
    getValue: (row) => row.accidents,
    format: (value) => formatCompact(value),
  },
  victims: {
    label: 'Victimas totales',
    getValue: (row) => row.victims,
    format: (value) => formatCompact(value),
  },
  fatalities: {
    label: 'Fallecidos',
    getValue: (row) => row.fatalities,
    format: (value) => formatNumber(value),
  },
}

function withBase(path) {
  const base = import.meta.env.BASE_URL || '/'
  return `${base}${path.replace(/^\/+/, '')}`
}

async function loadJson(path) {
  const response = await fetch(withBase(path))

  if (!response.ok) {
    throw new Error(`No se pudo cargar ${path}`)
  }

  return response.json()
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-ES').format(value)
}

function formatCompact(value) {
  return new Intl.NumberFormat('es-ES', {
    notation: 'compact',
    maximumFractionDigits: value >= 10000 ? 0 : 1,
  }).format(value)
}

function formatPercent(value, decimals = 1) {
  return `${new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)}%`
}

function percentage(value, total) {
  if (!total) {
    return 0
  }

  return (value / total) * 100
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  const normalized = clean.length === 3 ? clean.split('').map((char) => char + char).join('') : clean
  const numeric = Number.parseInt(normalized, 16)

  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  }
}

function interpolateColor(stops, value) {
  if (stops.length === 1) {
    const rgb = hexToRgb(stops[0])
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
  }

  const normalized = clamp(value, 0, 1)
  const scaled = normalized * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(scaled))
  const offset = scaled - index
  const from = hexToRgb(stops[index])
  const to = hexToRgb(stops[index + 1])
  const r = Math.round(from.r + (to.r - from.r) * offset)
  const g = Math.round(from.g + (to.g - from.g) * offset)
  const b = Math.round(from.b + (to.b - from.b) * offset)

  return `rgb(${r}, ${g}, ${b})`
}

function auroraScale(value, min, max) {
  if (max === min) {
    return interpolateColor(AURORA_STOPS, 0.5)
  }

  const normalized = (value - min) / (max - min)
  return interpolateColor(AURORA_STOPS, normalized)
}

function createFeatureCollection(features) {
  return { type: 'FeatureCollection', features }
}

function isCanaryProvince(feature) {
  const dashboardKey = feature.properties.dashboardKey?.toLowerCase()
  const dashboardName = feature.properties.dashboardName?.toLowerCase()

  return CANARY_PROVINCES.has(dashboardKey) || CANARY_PROVINCES.has(dashboardName)
}

function buildLinePath(points) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
}

function buildAreaPath(points, bottom) {
  if (!points.length) {
    return ''
  }

  const first = points[0]
  const last = points[points.length - 1]

  return [
    `M ${first.x.toFixed(2)} ${bottom.toFixed(2)}`,
    ...points.map((point, index) => `${index === 0 ? 'L' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
    `L ${last.x.toFixed(2)} ${bottom.toFixed(2)}`,
    'Z',
  ].join(' ')
}

function rankOf(list, predicate) {
  const index = list.findIndex(predicate)
  return index === -1 ? null : index + 1
}

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [geojson, setGeojson] = useState(null)
  const [tablesPayload, setTablesPayload] = useState(null)
  const [loadingError, setLoadingError] = useState(null)
  const [mapMetric, setMapMetric] = useState('accidents')
  const [trendMetric, setTrendMetric] = useState('accidents')
  const [victimMode, setVictimMode] = useState('urban')
  const [heatmapMode, setHeatmapMode] = useState('urban')
  const [selectedProvinceSlug, setSelectedProvinceSlug] = useState(null)
  const [theme, setTheme] = useState(() => document.body.dataset.nzTheme || 'light')
  const [tableSearch, setTableSearch] = useState('')
  const [selectedTableId, setSelectedTableId] = useState(null)
  const [activeHash, setActiveHash] = useState(() => window.location.hash || '#overview')
  const deferredTableSearch = useDeferredValue(tableSearch)

  useEffect(() => {
    let cancelled = false

    async function loadInitialData() {
      try {
        const [dashboardData, geojsonData] = await Promise.all([
          loadJson('data/dashboard.json'),
          loadJson('data/spain-provinces.geojson'),
        ])

        if (!cancelled) {
          setDashboard(dashboardData)
          setGeojson(geojsonData)
          setSelectedProvinceSlug(dashboardData.overview.defaultProvince)
        }
      } catch (error) {
        if (!cancelled) {
          setLoadingError(error instanceof Error ? error.message : 'No se pudieron cargar los datos')
        }
      }
    }

    loadInitialData()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!dashboard || tablesPayload) {
      return undefined
    }

    let cancelled = false

    async function loadTables() {
      try {
        const data = await loadJson('data/tables.json')

        if (!cancelled) {
          startTransition(() => {
            setTablesPayload(data)
            setSelectedTableId(data.sheets[1]?.sheetId ?? data.sheets[0]?.sheetId ?? null)
          })
        }
      } catch {
        if (!cancelled) {
          setTablesPayload({ meta: dashboard.meta, sheets: [] })
        }
      }
    }

    loadTables()

    return () => {
      cancelled = true
    }
  }, [dashboard, tablesPayload])

  useEffect(() => {
    document.body.dataset.nzTheme = theme
  }, [theme])

  useEffect(() => {
    const handleHashChange = () => {
      setActiveHash(window.location.hash || '#overview')
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  if (loadingError) {
    return <LoadingState error={loadingError} />
  }

  if (!dashboard || !geojson) {
    return <LoadingState />
  }

  const provinces = dashboard.overview.provinces
  const selectedProvince =
    provinces.find((province) => province.slug === selectedProvinceSlug) ?? provinces[0]

  const selectedRoadBreakdown =
    dashboard.risk.roadTypesByProvince.find((province) => province.slug === selectedProvince.slug) ??
    dashboard.risk.roadTypesByProvince[0]

  const metricConfig = MAP_METRICS[mapMetric]
  const provinceRanking = [...provinces]
    .sort(
      (left, right) =>
        metricConfig.getValueFromProvince(right) - metricConfig.getValueFromProvince(left),
    )
    .slice(0, 10)

  const selectedProvinceRank = rankOf(
    [...provinces].sort(
      (left, right) =>
        metricConfig.getValueFromProvince(right) - metricConfig.getValueFromProvince(left),
    ),
    (province) => province.slug === selectedProvince.slug,
  )

  const urbanShare = percentage(selectedProvince.urban.accidents, selectedProvince.total.accidents)
  const interurbanShare = 100 - urbanShare
  const selectedSeverity = percentage(
    selectedProvince.total.fatalities,
    selectedProvince.total.accidents,
  )

  const topProvinces = dashboard.overview.topProvincesByAccidents.slice(0, 5)
  const leadProvince = topProvinces[0]
  const weekdayRows = dashboard.trends.weekdays.slice(0, 7)
  const topVictimClasses = [...dashboard.victims.userClasses[victimMode]]
    .sort((left, right) => right.total.victims - left.total.victims)
    .slice(0, 6)

  const ageGroups = dashboard.victims.ageDistribution[victimMode]
  const topAccidentTypes = [...dashboard.risk.accidentTypes]
    .sort((left, right) => right.total.accidents - left.total.accidents)
    .slice(0, 8)

  const topInfractions = [...dashboard.risk.driverInfractions[victimMode]]
    .filter((infraction) => {
      const slug = infraction.slug
      return !slug.includes('se desconoce') && !slug.includes('ninguna') && !slug.includes('total')
    })
    .sort((left, right) => right.total - left.total)
    .slice(0, 8)

  const filteredTables = tablesPayload
    ? tablesPayload.sheets.filter((sheet) => {
        const query = deferredTableSearch.trim().toLowerCase()
        if (!query) {
          return true
        }

        return (
          sheet.sheetName.toLowerCase().includes(query) ||
          sheet.description.toLowerCase().includes(query)
        )
      })
    : []

  const activeTable =
    filteredTables.find((sheet) => sheet.sheetId === selectedTableId) ?? filteredTables[0] ?? null

  return (
    <div className="nz-app-shell accidentes-shell">
      <aside className="nz-app-shell__sidebar accidentes-sidebar">
        <div className="accidentes-brand">
          <div className="accidentes-brand__mark">A24</div>
          <div>
            <strong>Accidentes 2024</strong>
            <p className="nz-text-muted accidentes-brand__copy">Fuente: Excel ministerial de accidentes con victimas 2024.</p>
            <p className="nz-text-muted accidentes-brand__copy">Visualizacion: David Antizar.</p>
          </div>
        </div>

        <div className="nz-stack nz-stack--sm accidentes-sidebar__meta">
          <span className="nz-badge nz-badge--glass-brand">52 provincias</span>
          <span className="nz-badge nz-badge--glass-accent">18 comunidades</span>
          <span className="nz-badge nz-badge--glass">40 tablas explorables</span>
        </div>

        <nav className="nz-stack nz-stack--sm accidentes-sidebar__nav">
          <span className="nz-nav-section">Secciones</span>
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              className={`nz-nav-item${activeHash === item.href ? ' is-active' : ''}`}
              href={item.href}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="nz-card nz-card--glass accidentes-sidebar__note">
          <span className="nz-badge nz-badge--accent nz-badge--no-dot">Lectura correcta del dato</span>
          <p className="nz-text-sm nz-text-muted">
            El dataset no incluye coordenadas de cada siniestro. Por eso el mapa es provincial,
            con vistas interactivas sobre agregados reales y no sobre puntos inventados.
          </p>
        </div>
      </aside>

      <header className="nz-app-shell__header accidentes-header">
        <div>
          <h1 className="nz-text-h4">Accidentes con victimas en Espana · 2024</h1>
          <p className="nz-text-muted accidentes-header__sub">
            Fuente: Excel ministerial de accidentes con victimas 2024 · Visualizacion: David Antizar
          </p>
        </div>

        <div className="nz-cluster accidentes-header__actions">
          <a className="nz-btn nz-btn--ghost nz-btn--sm" href="#mapa">
            Ver mapa
          </a>
          <a className="nz-btn nz-btn--secondary nz-btn--sm" href="#tablas">
            Abrir tablas
          </a>
          <button
            className="nz-btn nz-btn--primary nz-btn--sm"
            type="button"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
          </button>
        </div>
      </header>

      <main className="nz-app-shell__main accidentes-main">
        <section id="overview" className="accidentes-hero nz-card nz-card--glass">
          <div className="nz-hero__inner accidentes-hero__inner">
            <div className="nz-stack accidentes-hero__copy">
              <span className="nz-hero__eyebrow">Datos oficiales 2024</span>
              <h2 className="nz-hero__title">Una lectura directa de los accidentes con victimas en Espana.</h2>
              <p className="nz-hero__sub">
                El panel reorganiza el Excel ministerial para responder rapido a tres preguntas:
                donde se concentran los accidentes, cuando suben y a quienes afectan mas.
              </p>
              <div className="accidentes-hero__meta">
                <span><strong>Fuente:</strong> Excel ministerial de accidentes con victimas 2024</span>
                <span><strong>Hecho por:</strong> David Antizar</span>
              </div>
              <div className="nz-hero__cta">
                <a className="nz-btn nz-btn--primary nz-btn--lg" href="#mapa">
                  Explorar el mapa
                </a>
                <a className="nz-btn nz-btn--secondary nz-btn--lg" href="#tablas">
                  Ir al explorador
                </a>
              </div>
            </div>

            <div className="accidentes-hero__summary nz-card nz-card--glass-soft">
              <div className="accidentes-hero__summary-grid">
                <article className="accidentes-hero__summary-stat">
                  <span>Accidentes</span>
                  <strong>{formatNumber(dashboard.overview.national.total.accidents)}</strong>
                </article>
                <article className="accidentes-hero__summary-stat">
                  <span>Fallecidos</span>
                  <strong>{formatNumber(dashboard.overview.national.total.fatalities)}</strong>
                </article>
                <article className="accidentes-hero__summary-stat">
                  <span>Mes pico</span>
                  <strong>{dashboard.trends.peakMonth.month}</strong>
                </article>
                <article className="accidentes-hero__summary-stat">
                  <span>Provincia con mas accidentes</span>
                  <strong>{leadProvince?.name}</strong>
                </article>
              </div>

              <div className="accidentes-hero__top">
                <div className="accidentes-hero__top-head">
                  <strong>Top provincias por accidentes</strong>
                  <span>Total anual</span>
                </div>

                <div className="accidentes-hero__top-list">
                  {topProvinces.map((province, index) => (
                    <div key={province.slug} className="accidentes-hero__top-item">
                      <span className="accidentes-hero__top-rank">{index + 1}</span>
                      <span className="accidentes-hero__top-name">{province.name}</span>
                      <strong>{formatCompact(province.total.accidents)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="nz-stat-grid nz-stat-grid--4 accidentes-kpis">
          <KpiCard
            label="Accidentes con victimas"
            value={formatCompact(dashboard.overview.national.total.accidents)}
            sub={`${formatNumber(dashboard.overview.national.total.accidents)} siniestros registrados`}
            delta={`${formatPercent(percentage(dashboard.overview.national.urban.accidents, dashboard.overview.national.total.accidents), 1)} urbano`}
            variant="aurora"
          />
          <KpiCard
            label="Fallecidos"
            value={formatNumber(dashboard.overview.national.total.fatalities)}
            sub={`${formatNumber(dashboard.overview.national.total.fatalAccidents)} accidentes mortales`}
            delta={`${formatNumber(dashboard.overview.national.interurban.fatalities)} en interurbano`}
          />
          <KpiCard
            label="Heridos hospitalizados"
            value={formatNumber(dashboard.overview.national.total.hospitalized)}
            sub={`${formatNumber(dashboard.overview.national.urban.hospitalized)} en ciudad`}
            delta={`${formatNumber(dashboard.overview.national.interurban.hospitalized)} fuera de ciudad`}
            variant="accent"
          />
          <KpiCard
            label="Heridos no hospitalizados"
            value={formatCompact(dashboard.overview.national.total.nonHospitalized)}
            sub={`${formatNumber(dashboard.overview.national.total.nonHospitalized)} victimas leves`}
            delta={`${formatNumber(dashboard.overview.national.urban.nonHospitalized)} urbanas`}
          />
        </div>

        <section id="mapa" className="accidentes-section">
          <SectionHeading
            eyebrow="Capa territorial"
            title="Mapa interactivo por provincia"
            description="No hay coordenadas por siniestro: la lectura correcta es provincial, con Canarias en escala ampliada para que se vea mejor."
            actions={
              <ToggleGroup
                options={Object.entries(MAP_METRICS).map(([value, config]) => ({
                  value,
                  label: config.label,
                }))}
                value={mapMetric}
                onChange={setMapMetric}
              />
            }
          />

          <div className="accidentes-map-grid">
            <section className="nz-card nz-card--glass-brand accidentes-map-card">
              <ProvinceMap
                geojson={geojson}
                selectedProvinceSlug={selectedProvince.slug}
                onSelect={setSelectedProvinceSlug}
                metricKey={mapMetric}
              />
            </section>

            <div className="accidentes-map-side">
              <section className="nz-card nz-card--glass accidentes-province-card">
                <div className="nz-card__header accidentes-province-card__header">
                  <div>
                    <span className="nz-badge nz-badge--primary nz-badge--no-dot">
                      Provincia seleccionada
                    </span>
                    <h3 className="nz-card__title">{selectedProvince.name}</h3>
                    <p className="nz-card__meta">
                      Puesto #{selectedProvinceRank} en {metricConfig.shortLabel} segun la vista actual.
                    </p>
                  </div>
                  <div
                    className="nz-donut nz-donut--aurora accidentes-share-donut"
                    style={{
                      '--p': urbanShare,
                      background: `conic-gradient(from 220deg, var(--nz-chart-1) 0 ${urbanShare}%, var(--nz-chart-2) ${urbanShare}% 100%)`,
                    }}
                  >
                    <span>{formatPercent(urbanShare, 0)}</span>
                  </div>
                </div>

                <div className="nz-stat-grid nz-stat-grid--2 accidentes-province-card__stats">
                  <StatTile label="Accidentes" value={formatNumber(selectedProvince.total.accidents)} />
                  <StatTile label="Fallecidos" value={formatNumber(selectedProvince.total.fatalities)} accent />
                  <StatTile label="Hospitalizados" value={formatNumber(selectedProvince.total.hospitalized)} />
                  <StatTile label="Severidad" value={`${selectedSeverity.toFixed(1)} / 100`} />
                </div>

                <div className="accidentes-split-bars">
                  <MetricSplit
                    label="Entorno urbano"
                    value={`${formatNumber(selectedProvince.urban.accidents)} accidentes`}
                    share={urbanShare}
                    accent={false}
                  />
                  <MetricSplit
                    label="Entorno interurbano"
                    value={`${formatNumber(selectedProvince.interurban.accidents)} accidentes`}
                    share={interurbanShare}
                    accent
                  />
                </div>

                <div className="nz-grid nz-grid--2 accidentes-road-grid">
                  <RoadBreakdownCard
                    title="Interurbano"
                    dominant={selectedRoadBreakdown.dominantInterurbanRoadType}
                    roadTypes={selectedRoadBreakdown.interurban.roadTypes}
                  />
                  <RoadBreakdownCard
                    title="Urbano"
                    dominant={selectedRoadBreakdown.dominantUrbanRoadType}
                    roadTypes={selectedRoadBreakdown.urban.roadTypes}
                  />
                </div>
              </section>

              <section className="nz-card nz-card--glass accidentes-ranking-card">
                <SectionHeading
                  eyebrow="Leaderboard"
                  title={`Top provincias por ${metricConfig.label.toLowerCase()}`}
                  description="El ranking se sincroniza con la metrica activa del mapa."
                />

                <div className="accidentes-ranking-list">
                  {provinceRanking.map((province, index) => (
                    <button
                      key={province.slug}
                      className={`accidentes-ranking-item${province.slug === selectedProvince.slug ? ' is-active' : ''}`}
                      type="button"
                      onClick={() => setSelectedProvinceSlug(province.slug)}
                    >
                      <span className="accidentes-ranking-item__rank">{index + 1}</span>
                      <span className="accidentes-ranking-item__name">{province.name}</span>
                      <span className="accidentes-ranking-item__value">
                        {metricConfig.format(metricConfig.getValueFromProvince(province))}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </section>

        <section id="ritmo" className="accidentes-section">
          <SectionHeading
            eyebrow="Capa temporal"
            title="Cuando se concentran los accidentes"
            description="Curva mensual, reparto semanal y matriz compacta para detectar cuando sube mas la siniestralidad."
            actions={
              <ToggleGroup
                options={Object.entries(TREND_METRICS).map(([value, config]) => ({
                  value,
                  label: config.label,
                }))}
                value={trendMetric}
                onChange={setTrendMetric}
              />
            }
          />

          <div className="nz-grid nz-grid--2 accidentes-trends-grid">
            <section className="nz-chart nz-chart--lg nz-chart--glass accidentes-chart-shell">
              <TrendLinesChart rows={dashboard.trends.months} metricKey={trendMetric} />
            </section>

            <section className="nz-card nz-card--glass accidentes-weekday-card">
              <div className="nz-card__header">
                <div>
                  <span className="nz-badge nz-badge--glass-brand nz-badge--no-dot">Semana</span>
                  <h3 className="nz-card__title">Dias con mayor carga</h3>
                </div>
              </div>
              <WeekdayBars rows={weekdayRows} metricKey={trendMetric} />
            </section>
          </div>

          <div className="nz-grid nz-grid--2 accidentes-trends-grid accidentes-trends-grid--lower">
            <section className="nz-card nz-card--glass-brand accidentes-heatmap-card">
              <SectionHeading
                eyebrow="Matriz horaria"
                title="Franja por dia y hora"
                description="Lectura comprimida para localizar rapido las horas con mayor carga."
                actions={
                  <ToggleGroup
                    options={[
                      { value: 'urban', label: 'Urbano' },
                      { value: 'interurban', label: 'Interurbano' },
                    ]}
                    value={heatmapMode}
                    onChange={setHeatmapMode}
                  />
                }
              />
              <HourlyHeatmap rows={dashboard.trends.hourly[heatmapMode]} />
            </section>

            <section className="nz-card nz-card--glass accidentes-insight-panel">
              <SectionHeading
                eyebrow="Hallazgos"
                title="Tres lecturas rapidas"
                description="Indicadores compactos para interpretar el calendario de siniestralidad."
              />

              <div className="accidentes-insight-panel__grid">
                <article className="nz-stat-tile nz-stat-tile--accent">
                  <div className="nz-stat-tile__icon">M</div>
                  <div className="nz-stat-tile__body">
                    <div className="nz-stat-tile__label">Mes pico</div>
                    <div className="nz-stat-tile__value">{dashboard.trends.peakMonth.month}</div>
                    <div className="nz-text-muted nz-text-sm">
                      {formatNumber(dashboard.trends.peakMonth.accidents)} accidentes
                    </div>
                  </div>
                </article>

                <article className="nz-stat-tile">
                  <div className="nz-stat-tile__icon">D</div>
                  <div className="nz-stat-tile__body">
                    <div className="nz-stat-tile__label">Dia pico</div>
                    <div className="nz-stat-tile__value">{dashboard.trends.peakWeekday.weekday}</div>
                    <div className="nz-text-muted nz-text-sm">
                      {formatNumber(dashboard.trends.peakWeekday.accidents)} accidentes
                    </div>
                  </div>
                </article>

                <article className="nz-stat-tile">
                  <div className="nz-stat-tile__icon">U</div>
                  <div className="nz-stat-tile__body">
                    <div className="nz-stat-tile__label">Peso urbano nacional</div>
                    <div className="nz-stat-tile__value">
                      {formatPercent(
                        percentage(
                          dashboard.overview.national.urban.accidents,
                          dashboard.overview.national.total.accidents,
                        ),
                        1,
                      )}
                    </div>
                    <div className="nz-text-muted nz-text-sm">sobre el total anual</div>
                  </div>
                </article>

                <article className="nz-stat-tile nz-stat-tile--accent">
                  <div className="nz-stat-tile__icon">I</div>
                  <div className="nz-stat-tile__body">
                    <div className="nz-stat-tile__label">Severidad interurbana</div>
                    <div className="nz-stat-tile__value">
                      {percentage(
                        dashboard.overview.national.interurban.fatalities,
                        dashboard.overview.national.interurban.accidents,
                      ).toFixed(1)}
                    </div>
                    <div className="nz-text-muted nz-text-sm">fallecidos por cada 100 accidentes</div>
                  </div>
                </article>
              </div>
            </section>
          </div>
        </section>

        <section id="victimas" className="accidentes-section">
          <SectionHeading
            eyebrow="Capa humana"
            title="Quien aparece en las victimas y como se desplaza"
            description="Los modos de transporte y las edades cambian mucho entre ciudad y carretera."
            actions={
              <ToggleGroup
                options={[
                  { value: 'urban', label: 'Vias urbanas' },
                  { value: 'interurban', label: 'Vias interurbanas' },
                ]}
                value={victimMode}
                onChange={setVictimMode}
              />
            }
          />

          <div className="nz-grid nz-grid--2 accidentes-victims-grid">
            <section className="nz-card nz-card--glass-brand accidentes-victim-modes">
              <SectionHeading
                eyebrow="Modos principales"
                title={`Victimas por medio de desplazamiento · ${victimMode === 'urban' ? 'urbano' : 'interurbano'}`}
                description="Se priorizan las categorias con mas victimas para comparar volumen y gravedad."
              />

              <div className="accidentes-mode-grid">
                {topVictimClasses.map((entry) => {
                  const driverShare = percentage(entry.driver.victims, entry.total.victims)
                  const pedestrianShare = percentage(entry.pedestrian.victims, entry.total.victims)
                  const passengerShare = percentage(entry.passenger.victims, entry.total.victims)

                  return (
                    <article key={entry.slug} className="nz-card nz-card--glass accidentes-mode-card">
                      <div className="nz-card__header">
                        <div>
                          <h3 className="nz-card__title accidentes-mode-card__title">{entry.className}</h3>
                          <p className="nz-card__meta">{formatNumber(entry.total.victims)} victimas</p>
                        </div>
                        <span className="nz-badge nz-badge--accent nz-badge--no-dot">
                          {formatNumber(entry.total.fatalities)} fallecidos
                        </span>
                      </div>

                      <div className="accidentes-mode-card__stats">
                        <div>
                          <strong>{formatNumber(entry.total.hospitalized)}</strong>
                          <span>hospitalizados</span>
                        </div>
                        <div>
                          <strong>{formatNumber(entry.total.nonHospitalized)}</strong>
                          <span>no hospitalizados</span>
                        </div>
                      </div>

                      <div className="accidentes-role-track" aria-hidden="true">
                        <span
                          className="accidentes-role-track__segment accidentes-role-track__segment--brand"
                          style={{ width: `${driverShare}%` }}
                        ></span>
                        <span
                          className="accidentes-role-track__segment accidentes-role-track__segment--accent"
                          style={{ width: `${passengerShare}%` }}
                        ></span>
                        <span
                          className="accidentes-role-track__segment accidentes-role-track__segment--violet"
                          style={{ width: `${pedestrianShare}%` }}
                        ></span>
                      </div>

                      <div className="accidentes-role-legend">
                        <span>Conductor {formatPercent(driverShare, 0)}</span>
                        <span>Pasajero {formatPercent(passengerShare, 0)}</span>
                        <span>Peaton {formatPercent(pedestrianShare, 0)}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>

            <section className="nz-card nz-card--glass accidentes-age-card">
              <SectionHeading
                eyebrow="Edad y sexo"
                title="Perfil de victimas por tramo de edad"
                description="Cada barra combina hombres, mujeres y casos sin sexo identificado dentro de la misma cohorte."
              />

              <AgeDistributionChart rows={ageGroups} />
            </section>
          </div>
        </section>

        <section id="riesgo" className="accidentes-section">
          <SectionHeading
            eyebrow="Capa de riesgo"
            title="Tipologias, infracciones y territorios dominantes"
            description="Dos lecturas directas: que tipos de accidente pesan mas y que infracciones aparecen con mas frecuencia."
          />

          <div className="nz-grid nz-grid--2 accidentes-risk-grid">
            <section className="nz-card nz-card--glass-brand accidentes-risk-card">
              <SectionHeading
                eyebrow="Tipologia"
                title="Accidentes mas frecuentes"
                description="Las categorias con mas casos combinan magnitud y gravedad de forma desigual."
              />
              <HorizontalMetricList
                items={topAccidentTypes.map((entry) => ({
                  key: entry.slug,
                  label: entry.type,
                  value: entry.total.accidents,
                  accent: `${formatNumber(entry.total.fatalities)} fallecidos`,
                }))}
                formatter={formatCompact}
              />
            </section>

            <section className="nz-card nz-card--glass accidentes-risk-card">
              <SectionHeading
                eyebrow={`Infracciones · ${victimMode === 'urban' ? 'urbano' : 'interurbano'}`}
                title="Conductas con mayor presencia"
                description="Se filtran las filas puramente agregadas para destacar las infracciones mas relevantes."
              />
              <HorizontalMetricList
                items={topInfractions.map((entry) => ({
                  key: entry.slug,
                  label: entry.infraction,
                  value: entry.total,
                  accent: topVehicleLabel(entry),
                }))}
                formatter={formatCompact}
                accentPalette
              />
            </section>
          </div>

        </section>

        <section id="tablas" className="accidentes-section">
          <SectionHeading
            eyebrow="Explorer"
            title="Las 40 tablas, sin volver al Excel"
            description="Busqueda por hoja y render directo de la estructura original ya convertida a JSON."
          />

          <section className="nz-card nz-card--glass-brand accidentes-table-card">
            {!tablesPayload ? (
              <div className="accidentes-table-loading">
                <div className="nz-skeleton nz-skeleton--title"></div>
                <div className="nz-skeleton nz-skeleton--text"></div>
                <div className="nz-skeleton nz-skeleton--text"></div>
              </div>
            ) : (
              <div className="accidentes-table-layout">
                <aside className="accidentes-table-sidebar">
                  <label className="nz-field">
                    <span className="nz-field__label">Buscar tabla</span>
                    <input
                      className="nz-input nz-search"
                      type="search"
                      placeholder="Ej. 7.1, provincias, edad..."
                      value={tableSearch}
                      onChange={(event) => setTableSearch(event.target.value)}
                    />
                  </label>

                  <div className="accidentes-table-list">
                    {filteredTables.map((sheet) => (
                      <button
                        key={sheet.sheetId}
                        className={`accidentes-table-list__item${activeTable?.sheetId === sheet.sheetId ? ' is-active' : ''}`}
                        type="button"
                        onClick={() => {
                          startTransition(() => {
                            setSelectedTableId(sheet.sheetId)
                          })
                        }}
                      >
                        <strong>{sheet.sheetName}</strong>
                        <span>{sheet.rowCount} filas · {sheet.columnCount} columnas</span>
                      </button>
                    ))}
                  </div>
                </aside>

                <div className="accidentes-table-content">
                  {activeTable ? (
                    <>
                      <div className="accidentes-table-content__head">
                        <div>
                          <span className="nz-badge nz-badge--glass-brand nz-badge--no-dot">
                            {activeTable.sheetName}
                          </span>
                          <h3 className="nz-text-h4 accidentes-table-content__title">
                            {activeTable.description}
                          </h3>
                        </div>
                        <span className="nz-text-muted nz-text-sm">
                          {activeTable.rowCount} filas renderizadas
                        </span>
                      </div>

                      <div className="nz-table-wrap accidentes-table-wrap">
                        <table className="nz-table accidentes-table">
                          <thead>
                            {activeTable.headerRows.map((row, rowIndex) => (
                              <tr key={`header-${rowIndex}`}>
                                {row.map((cell, cellIndex) => (
                                  <th key={`header-${rowIndex}-${cellIndex}`}>{cell || ' '}</th>
                                ))}
                              </tr>
                            ))}
                          </thead>
                          <tbody>
                            {activeTable.rows.map((row, rowIndex) => (
                              <tr key={`row-${rowIndex}`}>
                                {row.map((cell, cellIndex) => (
                                  <td key={`cell-${rowIndex}-${cellIndex}`}>{cell || ' '}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="nz-empty-state accidentes-empty-state">
                      <strong>No hay tablas que coincidan con la busqueda.</strong>
                      <p className="nz-text-muted">Prueba otra combinacion de terminos.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  )
}

function LoadingState({ error }) {
  return (
    <div className="nz accidentes-loading" data-nz-theme="light" data-nz-skin="aurora">
      <div className="nz-card nz-card--glass-brand accidentes-loading__card">
        <span className="nz-badge nz-badge--glass-brand nz-badge--no-dot">
          {error ? 'Error de carga' : 'Cargando dashboard'}
        </span>
        <h1 className="nz-text-h3">
          {error ?? 'Preparando mapa, graficos y tablas a partir del Excel del ministerio.'}
        </h1>
        {!error ? (
          <div className="nz-stack nz-stack--sm accidentes-loading__skeletons">
            <div className="nz-skeleton nz-skeleton--title"></div>
            <div className="nz-skeleton nz-skeleton--text"></div>
            <div className="nz-skeleton nz-skeleton--text"></div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SectionHeading({ eyebrow, title, description, actions }) {
  return (
    <div className="accidentes-section-heading">
      <div>
        <span className="nz-badge nz-badge--glass-brand nz-badge--no-dot">{eyebrow}</span>
        <h2 className="nz-text-h3 accidentes-section-heading__title">{title}</h2>
        <p className="nz-text-muted accidentes-section-heading__description">{description}</p>
      </div>
      {actions ? <div className="accidentes-section-heading__actions">{actions}</div> : null}
    </div>
  )
}

function ToggleGroup({ options, value, onChange }) {
  return (
    <div className="accidentes-toggle-group" role="tablist" aria-label="Selector de vista">
      {options.map((option) => (
        <button
          key={option.value}
          className={`accidentes-toggle-group__item${option.value === value ? ' is-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function KpiCard({ label, value, sub, delta, variant }) {
  const className =
    variant === 'accent'
      ? 'nz-kpi nz-kpi--accent'
      : variant === 'aurora'
        ? 'nz-kpi nz-kpi--aurora'
        : 'nz-kpi'

  return (
    <article className={className}>
      <span className="nz-kpi__label">{label}</span>
      <strong className="nz-kpi__value">{value}</strong>
      <span className="nz-kpi__sub">{sub}</span>
      <span className="nz-kpi__delta nz-kpi__delta--flat">{delta}</span>
    </article>
  )
}

function StatTile({ label, value, accent }) {
  return (
    <article className={`nz-stat-tile${accent ? ' nz-stat-tile--accent' : ''}`}>
      <div className="nz-stat-tile__icon">{label.slice(0, 1)}</div>
      <div className="nz-stat-tile__body">
        <div className="nz-stat-tile__label">{label}</div>
        <div className="nz-stat-tile__value">{value}</div>
      </div>
    </article>
  )
}

function MetricSplit({ label, value, share, accent }) {
  return (
    <div className="accidentes-metric-split">
      <div className="accidentes-metric-split__head">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className={`nz-progress${accent ? ' nz-progress--accent' : ' nz-progress--aurora'}`}>
        <span className="nz-progress__bar" style={{ width: `${share}%` }}></span>
      </div>
      <small>{formatPercent(share, 1)} del total</small>
    </div>
  )
}

function ProvinceMap({ geojson, selectedProvinceSlug, onSelect, metricKey }) {
  const width = 860
  const height = 620
  const metric = MAP_METRICS[metricKey]
  const values = geojson.features.map((feature) => metric.getValueFromFeature(feature.properties))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const steps = Array.from({ length: 5 }, (_, index) => min + ((max - min) / 4) * index)
  const mainlandFeatures = geojson.features.filter((feature) => !isCanaryProvince(feature))
  const canaryFeatures = geojson.features.filter((feature) => isCanaryProvince(feature))
  const mainlandProjection = geoMercator().fitExtent(
    [
      [18, 22],
      [width - 18, height - 22],
    ],
    createFeatureCollection(mainlandFeatures),
  )
  const mainlandPath = geoPath(mainlandProjection)
  const canaryInset = { x: width - 234, y: height - 164, width: 208, height: 120 }
  const canaryProjection =
    canaryFeatures.length > 0
      ? geoMercator().fitExtent(
          [
            [canaryInset.x + 14, canaryInset.y + 32],
            [canaryInset.x + canaryInset.width - 14, canaryInset.y + canaryInset.height - 16],
          ],
          createFeatureCollection(canaryFeatures),
        )
      : null
  const canaryPath = canaryProjection ? geoPath(canaryProjection) : null

  function renderProvince(feature, pathGenerator, keyPrefix = '') {
    const provinceKey = feature.properties.dashboardKey
    const value = metric.getValueFromFeature(feature.properties)
    const isSelected = provinceKey === selectedProvinceSlug
    const fill = isSelected ? 'url(#accidentes-selected-fill)' : auroraScale(value, min, max)

    return (
      <path
        key={`${keyPrefix}${provinceKey}`}
        d={pathGenerator(feature) ?? ''}
        className={`accidentes-map__shape${isSelected ? ' is-selected' : ''}`}
        fill={fill}
        tabIndex={0}
        role="button"
        aria-pressed={isSelected}
        onClick={() => onSelect(provinceKey)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(provinceKey)
          }
        }}
      >
        <title>
          {feature.properties.dashboardName}: {metric.format(value)}
        </title>
      </path>
    )
  }

  return (
    <div className="nz-map nz-map--hero nz-map--glass accidentes-map accidentes-map__container">
      <div className="nz-map__overlay nz-map__overlay--top-left accidentes-map__overlay">
        <strong>{metric.label}</strong>
        <p className="nz-text-muted">{metric.description}</p>
      </div>

      <div className="nz-map__overlay nz-map__overlay--top-right accidentes-map__overlay accidentes-map__overlay--compact">
        <strong>Granularidad real</strong>
        <p className="nz-text-muted">Mapa provincial, no puntos individuales.</p>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="accidentes-map__svg" role="img" aria-label="Mapa provincial interactivo de Espana">
        <defs>
          <linearGradient id="accidentes-selected-fill" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="48%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
        </defs>

        {mainlandFeatures.map((feature) => renderProvince(feature, mainlandPath))}

        {canaryPath && (
          <g className="accidentes-map__inset">
            <rect
              x={canaryInset.x}
              y={canaryInset.y}
              width={canaryInset.width}
              height={canaryInset.height}
              rx="18"
              className="accidentes-map__inset-frame"
            />
            <text x={canaryInset.x + 14} y={canaryInset.y + 20} className="accidentes-map__inset-label">
              Canarias
            </text>
            <text x={canaryInset.x + 14} y={canaryInset.y + 35} className="accidentes-map__inset-note">
              Escala ampliada
            </text>
            {canaryFeatures.map((feature) => renderProvince(feature, canaryPath, 'canary-'))}
          </g>
        )}
      </svg>

      <div className="nz-map__legend accidentes-map__legend">
        <strong>{metric.label}</strong>
        <div className="accidentes-map__legend-scale">
          {steps.map((step, index) => (
            <div key={`${metricKey}-${index}`} className="accidentes-map__legend-step">
              <span
                className="accidentes-map__legend-swatch"
                style={{ background: auroraScale(step, min, max) }}
              ></span>
              <span>{metric.format(step)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RoadBreakdownCard({ title, dominant, roadTypes }) {
  const topRoads = Object.entries(roadTypes)
    .map(([key, value]) => ({ key, label: ROAD_LABELS[key], accidents: value.accidents }))
    .sort((left, right) => right.accidents - left.accidents)
    .slice(0, 3)

  const max = topRoads[0]?.accidents ?? 1

  return (
    <article className="nz-card nz-card--glass-soft accidentes-road-card">
      <div className="nz-card__header">
        <div>
          <span className="nz-badge nz-badge--glass nz-badge--no-dot">{title}</span>
          <h3 className="nz-card__title accidentes-road-card__title">{dominant.label}</h3>
        </div>
        <span className="nz-text-muted nz-text-sm">dominante</span>
      </div>

      <div className="accidentes-road-card__list">
        {topRoads.map((road) => (
          <div key={road.key} className="accidentes-road-card__row">
            <div className="accidentes-road-card__head">
              <span>{road.label}</span>
              <strong>{formatNumber(road.accidents)}</strong>
            </div>
            <div className="nz-progress nz-progress--aurora">
              <span className="nz-progress__bar" style={{ width: `${(road.accidents / max) * 100}%` }}></span>
            </div>
          </div>
        ))}
      </div>
    </article>
  )
}

function TrendLinesChart({ rows, metricKey }) {
  const metric = TREND_METRICS[metricKey]
  const width = 680
  const height = 340
  const padding = { top: 28, right: 22, bottom: 46, left: 54 }
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const max = Math.max(
    ...rows.flatMap((row) => [metric.getValue(row.urban), metric.getValue(row.interurban)]),
  )
  const urbanPoints = rows.map((row, index) => {
    const x = padding.left + (innerWidth / (rows.length - 1)) * index
    const y = padding.top + innerHeight - (metric.getValue(row.urban) / max) * innerHeight

    return { x, y, label: row.month.slice(0, 3), value: metric.getValue(row.urban) }
  })
  const interurbanPoints = rows.map((row, index) => {
    const x = padding.left + (innerWidth / (rows.length - 1)) * index
    const y = padding.top + innerHeight - (metric.getValue(row.interurban) / max) * innerHeight

    return { x, y, label: row.month.slice(0, 3), value: metric.getValue(row.interurban) }
  })

  return (
    <div className="accidentes-chart accidentes-chart--lines">
      <div className="nz-chart__head">
        <div>
          <strong className="nz-chart__title">Curva mensual comparada</strong>
          <div className="nz-chart__sub">{metric.label} en urbano vs interurbano</div>
        </div>
        <ul className="nz-chart__legend">
          <li className="nz-chart__legend-item">
            <span className="nz-chart__legend-dot" style={{ background: 'var(--nz-chart-1)' }}></span>
            Urbano
          </li>
          <li className="nz-chart__legend-item">
            <span className="nz-chart__legend-dot" style={{ background: 'var(--nz-chart-2)' }}></span>
            Interurbano
          </li>
        </ul>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="accidentes-chart__svg">
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const y = padding.top + innerHeight - innerHeight * step
          return (
            <g key={step}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="accidentes-chart__grid" />
              <text x={12} y={y + 4} className="accidentes-chart__axis-text">
                {metric.format(Math.round(max * step))}
              </text>
            </g>
          )
        })}

        <path d={buildAreaPath(urbanPoints, padding.top + innerHeight)} className="accidentes-chart__area" />
        <path d={buildLinePath(urbanPoints)} className="accidentes-chart__line" />
        <path d={buildLinePath(interurbanPoints)} className="accidentes-chart__line accidentes-chart__line--accent" />

        {urbanPoints.map((point) => (
          <g key={`urban-${point.label}`}>
            <circle cx={point.x} cy={point.y} r="4" className="accidentes-chart__dot" />
            <text x={point.x} y={height - 16} className="accidentes-chart__axis-text accidentes-chart__axis-text--center">
              {point.label}
            </text>
          </g>
        ))}

        {interurbanPoints.map((point) => (
          <circle
            key={`interurban-${point.label}`}
            cx={point.x}
            cy={point.y}
            r="4"
            className="accidentes-chart__dot accidentes-chart__dot--accent"
          />
        ))}
      </svg>
    </div>
  )
}

function WeekdayBars({ rows, metricKey }) {
  const metric = TREND_METRICS[metricKey]
  const max = Math.max(...rows.map((row) => metric.getValue(row.total)))

  return (
    <div className="accidentes-weekday-bars">
      {rows.map((row) => (
        <div key={row.slug} className="accidentes-weekday-bars__item">
          <div className="accidentes-weekday-bars__head">
            <strong>{row.weekday}</strong>
            <span>{metric.format(metric.getValue(row.total))}</span>
          </div>
          <div className="nz-progress nz-progress--aurora nz-progress--sm">
            <span
              className="nz-progress__bar"
              style={{ width: `${(metric.getValue(row.total) / max) * 100}%` }}
            ></span>
          </div>
        </div>
      ))}
    </div>
  )
}

function HourlyHeatmap({ rows }) {
  const weekdayKeys = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
  const max = Math.max(...rows.flatMap((row) => weekdayKeys.map((key) => row[key])))
  const dayLabels = {
    lunes: 'L',
    martes: 'M',
    miercoles: 'X',
    jueves: 'J',
    viernes: 'V',
    sabado: 'S',
    domingo: 'D',
  }

  return (
    <div className="accidentes-heatmap">
      <div className="accidentes-heatmap__header">
        <span></span>
        {weekdayKeys.map((day) => (
          <strong key={day}>{dayLabels[day]}</strong>
        ))}
      </div>

      <div className="accidentes-heatmap__body">
        {rows.map((row) => (
          <div key={row.hour} className="accidentes-heatmap__row">
            <span className="accidentes-heatmap__label">{row.hour.slice(0, 5)}</span>
            {weekdayKeys.map((day) => (
              <span
                key={`${row.hour}-${day}`}
                className="accidentes-heatmap__cell"
                style={{ background: auroraScale(row[day], 0, max) }}
                title={`${day}: ${formatNumber(row[day])} accidentes en ${row.hour}`}
              ></span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function AgeDistributionChart({ rows }) {
  const max = Math.max(...rows.map((row) => row.total.totalVictims))

  return (
    <div className="accidentes-age-chart">
      <div className="accidentes-age-chart__legend">
        <span><i className="accidentes-age-chart__swatch accidentes-age-chart__swatch--male"></i>Hombre</span>
        <span><i className="accidentes-age-chart__swatch accidentes-age-chart__swatch--female"></i>Mujer</span>
        <span><i className="accidentes-age-chart__swatch accidentes-age-chart__swatch--unknown"></i>Sin dato</span>
      </div>

      <div className="accidentes-age-chart__rows">
        {rows.map((row) => (
          <div key={row.slug} className="accidentes-age-chart__row">
            <div className="accidentes-age-chart__labels">
              <strong>{row.ageGroup}</strong>
              <span>{formatNumber(row.total.totalVictims)} victimas</span>
            </div>

            <div className="accidentes-age-chart__track accidentes-age-chart__track--stacked">
              <span
                className="accidentes-age-chart__segment accidentes-age-chart__segment--male"
                style={{ width: `${(row.male.totalVictims / row.total.totalVictims) * 100}%` }}
                title={`Hombre: ${formatNumber(row.male.totalVictims)}`}
              ></span>
              <span
                className="accidentes-age-chart__segment accidentes-age-chart__segment--female"
                style={{ width: `${(row.female.totalVictims / row.total.totalVictims) * 100}%` }}
                title={`Mujer: ${formatNumber(row.female.totalVictims)}`}
              ></span>
              <span
                className="accidentes-age-chart__segment accidentes-age-chart__segment--unknown"
                style={{ width: `${(row.unknown.totalVictims / row.total.totalVictims) * 100}%` }}
                title={`Sin dato: ${formatNumber(row.unknown.totalVictims)}`}
              ></span>
            </div>

            <div className="accidentes-age-chart__scale">
              <span
                className="accidentes-age-chart__scale-bar"
                style={{ width: `${(row.total.totalVictims / max) * 100}%` }}
              ></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HorizontalMetricList({ items, formatter, accentPalette }) {
  const max = Math.max(...items.map((item) => item.value))

  return (
    <div className="accidentes-horizontal-list">
      {items.map((item) => (
        <div key={item.key} className="accidentes-horizontal-list__row">
          <div className="accidentes-horizontal-list__head">
            <strong>{item.label}</strong>
            <span>{formatter(item.value)}</span>
          </div>
          <div className="accidentes-horizontal-list__track">
            <span
              className={`accidentes-horizontal-list__bar${accentPalette ? ' is-accent' : ''}`}
              style={{ width: `${(item.value / max) * 100}%` }}
            ></span>
          </div>
          <small>{item.accent}</small>
        </div>
      ))}
    </div>
  )
}

function topVehicleLabel(entry) {
  const candidates = Object.entries(VEHICLE_LABELS).map(([key, label]) => ({
    key,
    label,
    value: entry[key],
  }))
  const top = candidates.sort((left, right) => right.value - left.value)[0]

  return `${top.label}: ${formatNumber(top.value)}`
}

export default App
