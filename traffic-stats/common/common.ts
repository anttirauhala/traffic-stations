import axios from 'axios';
import { Station } from './interfaces';

export const getTampereStations = async (): Promise<Station[]> => {
  // Fetch basic station data
  const stationsResponse = await axios.get('https://tie.digitraffic.fi/api/tms/v1/stations');
  const stations: Station[] = stationsResponse.data.features.map((feature: any) => ({
    id: feature.properties.id,
    name: feature.properties.name,
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
    fullName: feature.properties.name, // Default to name initially
    direction1Municipality: undefined, // set when station is selected
    direction2Municipality: undefined, // set when station is selected
    municipality: undefined, // set when station is selected
  }));

  // Filter stations near Tampere
  const tampereStations = stations.filter(station => {
    return station.lat >= 61.4 && station.lat <= 61.6 && station.lon >= 23.6 && station.lon <= 23.9;
  });

  console.log('Fetched basic station data:', tampereStations);

  try {
    // Fetch detailed station data from DATEX2 API
    console.log('Fetching DATEX2 data...');
    let datex2Response;
    
    try {
      datex2Response = await axios.get('https://tie.digitraffic.fi/api/tms/v1/stations/datex2?state=ACTIVE');
      console.log('DATEX2 data received');
    } catch (error) {
      console.error('Failed to fetch DATEX2 data:', error);
      return tampereStations;
    }
    
    // Verify that measurementSiteTable exists in the response
    if (!datex2Response?.data?.measurementSiteTable?.length || 
        !datex2Response.data.measurementSiteTable[0]?.measurementSite?.length) {
      console.error('Invalid DATEX2 response structure');
      return tampereStations;
    }
    
    const measurementSites = datex2Response.data.measurementSiteTable[0].measurementSite;
    console.log(`Found ${measurementSites.length} measurement sites in DATEX2 data`);
    
    // Create a simple map for lookup with string IDs
    const siteMap = new Map();
    
    measurementSites.forEach((site: any) => {
      if (!site.idG) return;
      
      // Convert ID to string for consistent comparison
      const siteId = String(site.idG);
      
      // Try multiple properties for fullName in order of preference
      const fullName = getFullNameFromSite(site);
      const siteInfo = {
        fullName: fullName,
        siteIdentification: site.measurementSiteIdentification || ''
      };
      
      // Store with string ID for consistent lookup
      siteMap.set(siteId, siteInfo);
    });
    
    // Enhance Tampere stations with DATEX2 data
    tampereStations.forEach(station => {
      // Convert station ID to string for consistent comparison
      const stationIdStr = String(station.id);
      const siteInfo = siteMap.get(stationIdStr);
      
      if (siteInfo) {
        // Only update fullName if we found a better value
        if (siteInfo.fullName && siteInfo.fullName.length > 0) {
          station.fullName = siteInfo.fullName;
        }
        
        if (siteInfo.siteIdentification) {
          station.description = siteInfo.siteIdentification;
        }
      } else {
        console.log(`No DATEX2 data found for station ${stationIdStr}`);
      }
    });
  } catch (error) {
    console.error('Error processing station data:', error);
  }

  return tampereStations;
};

// Helper function to extract the fullName from a measurement site
function getFullNameFromSite(site: any): string {
  // Try multiple approaches to get a meaningful name
  
  // First try: measurementSiteName values with Finnish language
  if (site.measurementSiteName?.values && Array.isArray(site.measurementSiteName.values)) {
    const fiValue = site.measurementSiteName.values.find((val: any) => val.lang === 'fi');
    if (fiValue && fiValue.value) {
      return fiValue.value;
    }
    
    // If no Finnish value, take the first one
    if (site.measurementSiteName.values.length > 0 && site.measurementSiteName.values[0].value) {
      return site.measurementSiteName.values[0].value;
    }
  }
  
  // Second try: direct value in measurementSiteName
  if (site.measurementSiteName?.value) {
    return site.measurementSiteName.value;
  }
  
  // Third try: measurementSiteIdentification
  if (site.measurementSiteIdentification) {
    return site.measurementSiteIdentification;
  }
  
  // Last resort: return empty string
  return '';
}