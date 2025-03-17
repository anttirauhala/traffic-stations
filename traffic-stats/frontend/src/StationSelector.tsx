import * as React from "react";
import { useState, useEffect, useRef } from "react";
import axios from "axios";
import API_URL from "./config";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix for Leaflet marker icon issue in React
// This is needed because Leaflet's default icon relies on assets that aren't properly loaded in React
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png",
});

interface StationEnriched extends Station {
  direction1Municipality?: string;
  direction2Municipality?: string;
  municipality?: string;
}

interface HourlyData {
  hour: number;
  trafficCount: number;
  avgSpeed: number;
}

interface SensorHourlyData {
  name: string;
  unit: string;
  hourlyData: {
    hour: number;
    value: number;
  }[];
}

interface HourlyAverage {
  stationId: string;
  period: {
    start: string;
    end: string;
  };
  hourlyAverages: HourlyData[];
  sensorData?: SensorHourlyData[];
}

interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  fullName?: string;
  description?: string;
  collectionStatus?: string;
}

interface StationSelectorProps {
  stations: Station[];
}

const RecenterMap: React.FC<{ lat: number; lon: number }> = ({ lat, lon }) => {
  const map = useMap();
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    map.setView([lat, lon], 13);
  }, [lat, lon, map]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    if (mapContainerRef.current) {
      observer.observe(mapContainerRef.current);
    }
    return () => {
      if (mapContainerRef.current) {
        observer.unobserve(mapContainerRef.current);
      }
    };
  }, [map]);

  return (
    <div ref={mapContainerRef} style={{ height: "100%", width: "100%" }} />
  );
};

const StationSelector: React.FC<StationSelectorProps> = ({ stations }) => {
  const [selectedStation, setSelectedStation] = useState<string>("");
  const [hourlyAverage, setHourlyAverage] = useState<HourlyAverage | null>(
    null
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [isDropdownHovered, setIsDropdownHovered] = useState<boolean>(false);
  const [selectedStationData, setSelectedStationData] =
    useState<StationEnriched | null>(null);

  // Reference to the dropdown element to handle outside clicks
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Handle outside clicks to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (selectedStation) {
      const fetchHourlyAverage = async () => {
        setLoading(true);
        setError(null);
        try {
          const response = await axios.get(
            `${API_URL}/traffic/station/${selectedStation}/hourly-average`
          );
          setHourlyAverage(response.data);
        } catch (error) {
          console.error("Error fetching hourly average:", error);
          setError("Failed to fetch data. Please try again.");
        } finally {
          setLoading(false);
        }
      };
      fetchHourlyAverage();
    }
  }, [selectedStation]);

  // Debug selected station data
  React.useEffect(() => {
    if (selectedStation && selectedStationData) {
      console.log("Selected station details:", selectedStationData);
    }
  }, [selectedStation, selectedStationData]);

  // Format the data for the charts
  const formatHourLabel = (hour: number): string => {
    return `${hour}:00`;
  };

  const fetchStationDetails = async (stationId: string) => {
    try {
      const response = await axios.get(
        `https://tie.digitraffic.fi/api/tms/v1/stations/${stationId}`
      );
      return response.data;
    } catch (error) {
      console.error("Failed to fetch station details:", error);
      return null;
    }
  };

  const handleStationSelect = async (stationId: string) => {
    setSelectedStation(stationId); // Set the selected station immediately
    const stationDetails = await fetchStationDetails(stationId);
    if (stationDetails && stationDetails.id) {
      const station = stations.find((s) => s.id === stationId);
      if (station) {
        setSelectedStationData({
          ...station,
          direction1Municipality: stationDetails.properties.direction1Municipality,
          direction2Municipality: stationDetails.properties.direction2Municipality,
          municipality: stationDetails.properties.municipality,
        });
        console.log("Selected station details:", stationDetails);
      }
    }
  };

  return (
    <div style={styles.stationSelector}>
      <div style={styles.selectorContainer}>
        <label htmlFor="station" style={styles.selectorLabel}>
          Select a traffic measurement station:
        </label>

        {/* Custom styled dropdown */}
        <div style={styles.customDropdown} ref={dropdownRef}>
          <div
            style={{
              ...styles.dropdownSelected,
              ...(isDropdownHovered ? styles.dropdownSelectedHover : {}),
            }}
            onClick={() => setDropdownOpen(!dropdownOpen)}
            onMouseEnter={() => setIsDropdownHovered(true)}
            onMouseLeave={() => setIsDropdownHovered(false)}
          >
            <span style={styles.selectedText}>
              {selectedStation
                ? stations.find((s) => s.id === selectedStation)?.fullName ||
                  stations.find((s) => s.id === selectedStation)?.name ||
                  "Select a station"
                : "Select a station"}
            </span>
            <span style={styles.dropdownArrow}>{dropdownOpen ? "▲" : "▼"}</span>
          </div>

          {dropdownOpen && (
            <div style={styles.dropdownOptions}>
              {stations.length === 0 ? (
                <div style={styles.dropdownOption}>Loading stations...</div>
              ) : (
                <>
                  <div
                    style={{
                      ...styles.dropdownOption,
                      ...(hoveredItem === "default"
                        ? styles.dropdownOptionHover
                        : {}),
                    }}
                    onClick={() => {
                      setSelectedStation("");
                      setDropdownOpen(false);
                    }}
                    onMouseEnter={() => setHoveredItem("default")}
                    onMouseLeave={() => setHoveredItem(null)}
                  >
                    -- Select a station --
                  </div>
                  {stations.map((station) => (
                    <div
                      key={station.id}
                      style={{
                        ...styles.dropdownOption,
                        ...(selectedStation === station.id
                          ? styles.dropdownOptionSelected
                          : {}),
                        ...(hoveredItem === station.id
                          ? styles.dropdownOptionHover
                          : {}),
                      }}
                      onClick={() => {
                        setSelectedStation(station.id);
                        setDropdownOpen(false);
                        handleStationSelect(station.id);
                      }}
                      onMouseEnter={() => setHoveredItem(station.id)}
                      onMouseLeave={() => setHoveredItem(null)}
                    >
                      {station.fullName ? `${station.fullName}` : station.name}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Keep the original select hidden for accessibility */}
        <select
          id="station"
          value={selectedStation}
          onChange={(e) => setSelectedStation(e.target.value)}
          style={styles.hiddenSelect}
          aria-hidden="true"
        >
          <option value="">--Select a station--</option>
          {stations.map((station) => (
            <option key={station.id} value={station.id}>
              {station.fullName ? `${station.fullName}` : station.name}
            </option>
          ))}
        </select>
      </div>

      {loading && <div style={styles.loading}>Loading data...</div>}
      {error && <div style={styles.error}>{error}</div>}

      {/* Map display for selected station */}
      {selectedStationData && !loading && (
        <details style={styles.mapDetails} open>
          <summary style={styles.mapSummary}>Station Location Map</summary>
          <div style={styles.mapContainer}>
            <MapContainer
              center={[selectedStationData.lat, selectedStationData.lon]}
              zoom={13}
              style={styles.map}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker
                position={[selectedStationData.lat, selectedStationData.lon]}
              >
                <Popup>
                  <strong>
                    {selectedStationData.fullName || selectedStationData.name}
                  </strong>
                  <br />
                  ID: {selectedStationData.id}
                  <br />
                  Coordinates: {selectedStationData.lat.toFixed(5)},{" "}
                  {selectedStationData.lon.toFixed(5)}
                  {selectedStationData.description && (
                    <>
                      <br />
                      {selectedStationData.description}
                    </>
                  )}
                </Popup>
              </Marker>
              <RecenterMap
                lat={selectedStationData.lat}
                lon={selectedStationData.lon}
              />
            </MapContainer>
          </div>
          <div style={styles.stationDetails}>
            <p><strong>Municipality:</strong> {selectedStationData.municipality}</p>
            <p><strong>Direction 1 Municipality:</strong> {selectedStationData.direction1Municipality}</p>
            <p><strong>Direction 2 Municipality:</strong> {selectedStationData.direction2Municipality}</p>
            <p><strong>Period:</strong> {hourlyAverage?.period.start} to {hourlyAverage?.period.end}</p>
            <p><strong>Collection Status:</strong> {selectedStationData.collectionStatus}</p>
          </div>
        </details>
      )}

      {hourlyAverage && !loading && selectedStationData && (
        <div style={styles.chartsContainer}>
          <h2 style={styles.h2}>
            Traffic Data for Station:{" "}
            {selectedStationData.fullName || selectedStationData.name}
          </h2>

          <div style={styles.chartWrapper}>
            <h3 style={styles.h3}>Hourly Traffic Count</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={hourlyAverage.hourlyAverages}
                margin={{
                  top: 5,
                  right: 30,
                  left: 20,
                  bottom: 5,
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" tickFormatter={formatHourLabel} />
                <YAxis
                  label={{
                    value: "Vehicles per hour",
                    angle: -90,
                    position: "insideLeft",
                  }}
                />
                <RechartsTooltip
                  formatter={(value) => [`${value} vehicles`, "Traffic Count"]}
                  labelFormatter={formatHourLabel}
                />
                <Legend />
                <Bar
                  dataKey="trafficCount"
                  name="Traffic Count"
                  fill="#8884d8"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={styles.chartWrapper}>
            <h3 style={styles.h3}>Average Vehicle Speed</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={hourlyAverage.hourlyAverages}
                margin={{
                  top: 5,
                  right: 30,
                  left: 20,
                  bottom: 5,
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" tickFormatter={formatHourLabel} />
                <YAxis
                  label={{
                    value: "Speed (km/h)",
                    angle: -90,
                    position: "insideLeft",
                  }}
                />
                <RechartsTooltip
                  formatter={(value) => [`${value} km/h`, "Average Speed"]}
                  labelFormatter={formatHourLabel}
                />
                <Legend />
                <Bar dataKey="avgSpeed" name="Average Speed" fill="#82ca9d" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {hourlyAverage.sensorData && hourlyAverage.sensorData.length > 0 && (
            <div style={styles.sensorSpecificCharts}>
              <h3 style={styles.h3}>Sensor-Specific Data</h3>

              {/* Show charts for key sensor types */}
              {hourlyAverage.sensorData
                .filter(
                  (sensor) =>
                    sensor.name.includes("OHITUKSET_60MIN") ||
                    sensor.name.includes("KESKINOPEUS_60MIN")
                )
                .map((sensor) => (
                  <div key={sensor.name} style={styles.sensorChart}>
                    <h4 style={styles.h4}>
                      {sensor.name} ({sensor.unit})
                    </h4>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart
                        data={sensor.hourlyData}
                        margin={{
                          top: 5,
                          right: 30,
                          left: 20,
                          bottom: 5,
                        }}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="hour" tickFormatter={formatHourLabel} />
                        <YAxis />
                        <RechartsTooltip
                          formatter={(value) => [
                            `${value} ${sensor.unit}`,
                            sensor.name,
                          ]}
                          labelFormatter={formatHourLabel}
                        />
                        <Legend />
                        <Bar
                          dataKey="value"
                          name={sensor.name}
                          fill={
                            sensor.name.includes("OHITUKSET")
                              ? "#8884d8"
                              : "#82ca9d"
                          }
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ))}
            </div>
          )}

          <details style={styles.rawData}>
            <summary style={styles.rawDataSummary}>Show Raw Data</summary>
            <pre style={styles.rawDataPre}>
              {JSON.stringify(hourlyAverage, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
};

// Define styles as JavaScript object
import { CSSProperties } from "react";

const styles: { [key: string]: CSSProperties } = {
  stationSelector: {
    fontFamily: "Arial, sans-serif",
    maxWidth: "1200px",
    margin: "0 auto",
    padding: "20px",
  },
  selectorContainer: {
    marginBottom: "20px",
    display: "flex",
    flexDirection: "column" as "column",
    alignItems: "center",
  },
  selectorLabel: {
    fontWeight: "bold",
    marginBottom: "10px",
  },
  stationDropdown: {
    padding: "8px",
    fontSize: "16px",
    borderRadius: "4px",
    minWidth: "250px",
  },
  loading: {
    padding: "20px",
    textAlign: "center" as const,
    borderRadius: "4px",
    margin: "20px 0",
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
  },
  error: {
    padding: "20px",
    textAlign: "center" as const,
    borderRadius: "4px",
    margin: "20px 0",
    backgroundColor: "#ffebee",
    color: "#c62828",
  },
  chartsContainer: {
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    padding: "20px",
    borderRadius: "8px",
    boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
  },
  chartWrapper: {
    marginBottom: "30px",
    backgroundColor: "white",
    padding: "15px",
    borderRadius: "4px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
  },
  period: {
    color: "#666",
    fontStyle: "italic",
  },
  h2: {
    color: "#333",
    marginBottom: "5px",
  },
  h3: {
    color: "#444",
    marginBottom: "15px",
  },
  h4: {
    color: "#555",
    marginBottom: "10px",
  },
  sensorSpecificCharts: {
    marginTop: "30px",
  },
  sensorChart: {
    marginBottom: "25px",
    backgroundColor: "white",
    padding: "15px",
    borderRadius: "4px",
  },
  rawData: {
    marginTop: "30px",
    cursor: "pointer",
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
  },
  rawDataSummary: {
    fontWeight: "bold",
    padding: "10px",
    backgroundColor: "#eee",
    borderRadius: "4px",
  },
  rawDataPre: {
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    padding: "15px",
    overflow: "auto",
    maxHeight: "300px",
    borderRadius: "0 0 4px 4px",
  },
  stationFullName: {
    fontWeight: "normal",
    fontSize: "0.9em",
    color: "#555",
  },
  stationDescription: {
    fontSize: "0.9em",
    color: "#666",
    margin: "5px 0 15px",
  },
  stationId: {
    fontSize: "0.9em",
    color: "#777",
    margin: "5px 0",
    fontWeight: "normal",
  },
  // Enhanced dropdown styles with fixed border properties
  customDropdown: {
    position: "relative" as const,
    width: "100%",
    maxWidth: "500px",
    fontSize: "16px",
    zIndex: 1000, // Increased z-index to ensure dropdown is above map
  },
  dropdownSelected: {
    display: "flex" as const,
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
    padding: "10px 15px",
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ccc",
    borderRadius: "6px",
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    transition: "all 0.2s ease",
  },
  dropdownSelectedHover: {
    borderColor: "#aaa",
    boxShadow: "0 1px 6px rgba(0,0,0,0.1)",
  },
  selectedText: {
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
  },
  dropdownArrow: {
    marginLeft: "10px",
    fontSize: "12px",
    color: "#666",
  },
  dropdownOptions: {
    position: "absolute" as const,
    top: "calc(100% + 5px)",
    left: 0,
    right: 0,
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ddd",
    borderRadius: "6px",
    maxHeight: "350px",
    overflowY: "auto" as const,
    boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
    zIndex: 1001, // Higher z-index to ensure dropdown options are on top
  },
  dropdownOption: {
    padding: "12px 15px",
    cursor: "pointer",
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    borderBottomWidth: "1px",
    // borderBottomStyle: 'solid',
    borderBottomColor: "#f0f0f0",
    transition: "background-color 0.15s ease",
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
  },
  dropdownOptionSelected: {
    backgroundColor: "#f0f7ff",
    color: "#0066cc", // Ensure text is visible in dark mode
    fontWeight: "bold" as const,
  },
  dropdownOptionHover: {
    backgroundColor: "#f6f9ff",
    color: "black", // Ensure text is visible in dark mode
  },
  hiddenSelect: {
    position: "absolute" as const,
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    borderWidth: 0,
  },
  // Map styles
  mapDetails: {
    marginBottom: "20px",
    backgroundColor: "white",
    color: "black", // Ensure text is visible in dark mode
    borderRadius: "8px",
    boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
    overflow: "hidden",
    position: "relative" as const,
    zIndex: 100, // Lower z-index for the map container
  },
  mapSummary: {
    padding: "12px 15px",
    fontWeight: "bold" as const,
    cursor: "pointer",
    backgroundColor: "#f0f7ff",
    borderBottom: "1px solid #e0e0e0",
  },
  mapContainer: {
    padding: "15px",
    position: "relative" as const,
    zIndex: 10, // Even lower z-index for the map itself
  },
  map: {
    height: "400px",
    width: "100%",
    borderRadius: "4px",
    border: "1px solid #e0e0e0",
    zIndex: 10, // Matching z-index for consistency
  },
  stationDetails: {
    padding: "15px",
    backgroundColor: "#f9f9f9",
    borderRadius: "4px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
    marginTop: "10px",
  },
};

export default StationSelector;
