import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { SensorValue } from '../../../../../common/interfaces';

// Add TypeScript declaration for the isDST method
declare global {
  interface Date {
    isDST(): boolean;
  }
}

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Converts UTC time to Helsinki time and returns the hour (0-23)
 * Uses caching to improve performance
 */
const hourCache: { [timeString: string]: number } = {};
const getHelsinkiHour = (utcTimeString: string): number => {
  // Check if we've already calculated this hour
  if (hourCache[utcTimeString] !== undefined) {
    return hourCache[utcTimeString];
  }

  // Create a date object from the UTC time string
  const date = new Date(utcTimeString);
  
  // Convert to Helsinki time (EET/EEST) - UTC+2/UTC+3
  // This is much faster than using toLocaleString with timezone
  const helsinkiOffset = date.getTimezoneOffset() + (date.isDST() ? 180 : 120);
  const helsinkiTime = new Date(date.getTime() + helsinkiOffset * 60000);
  
  // Store in cache and return the hour
  hourCache[utcTimeString] = helsinkiTime.getHours();
  return hourCache[utcTimeString];
};

// Helper function to determine if a date is in DST (Daylight Saving Time)
Date.prototype.isDST = function() {
  const jan = new Date(this.getFullYear(), 0, 1);
  const jul = new Date(this.getFullYear(), 6, 1);
  return this.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
};

/**
 * API handler for getting hourly average traffic data for a specific station
 * based on data from the last month
 * Endpoint: GET /traffic/station/{stationId}/hourly-average
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // Enable CORS
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json'
    };
    
    // Handle OPTIONS request for CORS
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: ''
      };
    }
    
    const stationId = event.pathParameters?.stationId;
    
    if (!stationId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Missing stationId parameter' })
      };
    }
    
    console.log(`Getting hourly average data for station ${stationId} from the last month`);
    
    const tableName = process.env.DYNAMODB_TABLE_NAME;
    if (!tableName) {
      throw new Error('DYNAMODB_TABLE_NAME environment variable is not defined');
    }
    
    // Calculate the date range for the last month
    const today = new Date();
    const lastMonth = new Date(today);
    lastMonth.setMonth(today.getMonth() - 1);
    
    const startDate = lastMonth.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];
    
    // Query DynamoDB for all records for this station within the last month
    // Using measuredTime instead of timeWindowStart to match the table's sort key
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'stationId = :stationId AND begins_with(compositeKey, :compositeKeyPrefix)',
      FilterExpression: 'measuredTime BETWEEN :startDate AND :endDate',
      ExpressionAttributeValues: {
        ':stationId': parseInt(stationId, 10), // Convert to number to match the table schema
        ':compositeKeyPrefix': `${stationId}#`, // Use stationId as the prefix for compositeKey
        ':startDate': new Date(startDate).toISOString(),
        ':endDate': new Date(endDate + 'T23:59:59.999Z').toISOString() // Include the entire end date
      }
    }));

    console.log('Query result items:', result.Items);

    const items: SensorValue[] = result.Items as SensorValue[] || [];
    console.log(`Found ${items.length} records for station ${stationId}`);
    
    // Group by sensor name and hour
    const groupedByNameAndHour: { [name: string]: { [hour: number]: { sum: number, count: number } } } = {};
    console.log('Grouping records by sensor name and hour...');
    
    // Precompute a map of sensor names to their units to avoid repeated `find` operations
    const sensorUnitMap: { [name: string]: string } = {};
    for (const item of items) {
      if (!sensorUnitMap[item.name]) {
        sensorUnitMap[item.name] = item.unit || '';
      }
    }

    // Initialize groupedByNameAndHour structure for all sensor names and hours upfront
    for (const item of items) {
      if (!groupedByNameAndHour[item.name]) {
        groupedByNameAndHour[item.name] = {};
        for (let hour = 0; hour < 24; hour++) {
          groupedByNameAndHour[item.name][hour] = { sum: 0, count: 0 };
        }
      }
    }

    // Process items with the optimized getHelsinkiHour function
    for (const item of items) {
      if (!item.value || item.value === 0) continue;

      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = getHelsinkiHour(timeString);

      // Update sum and count for the corresponding hour
      groupedByNameAndHour[item.name][hour].sum += item.value;
      groupedByNameAndHour[item.name][hour].count++;
    }
    
    console.log('Grouped by name and hour');
    
    // Convert grouped data to the response format
    const hourlyAveragesByName: { 
      name: string;
      unit: string;
      hourlyData: { hour: number; value: number }[]
    }[] = [];
    
    // Process each sensor type
    for (const [name, hourData] of Object.entries(groupedByNameAndHour)) {
      const hourlyData: { hour: number; value: number }[] = [];
      
      // Process each hour for this sensor type
      for (let hour = 0; hour < 24; hour++) {
        const data = hourData[hour];
        if (data && data.count > 0) {
          hourlyData.push({
            hour,
            value: Number((data.sum / data.count).toFixed(1))
          });
        } else {
          hourlyData.push({ hour, value: 0 });
        }
      }
      
      hourlyAveragesByName.push({
        name,
        unit: sensorUnitMap[name],
        hourlyData
      });
    }
    console.log('Converted grouped data to response format');
    
    // Calculate overall averages by hour (maintaining backward compatibility)
    const hourlyAverages = Array(24).fill(null).map(() => ({
      trafficCount: 0,
      avgSpeed: 0,
      dataPoints: 0
    }));
    
    // Find traffic count and speed sensors
    const trafficCountSensors = items.filter(item => 
      (item.name.includes('OHITUKSET') && item.unit === 'kpl/h')
    );
    
    const speedSensors = items.filter(item => 
      (item.name.includes('KESKINOPEUS') && item.unit === 'km/h')
    );
    
    // Calculate traffic count averages by hour
    for (const item of trafficCountSensors) {
      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = getHelsinkiHour(timeString);
      
      hourlyAverages[hour].trafficCount += item.value || 0;
      hourlyAverages[hour].dataPoints += 1;
    }
    console.log('Calculated traffic count averages by hour');
    
    // Calculate speed averages by hour
    for (const item of speedSensors) {
      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = getHelsinkiHour(timeString);
      
      hourlyAverages[hour].avgSpeed += item.value || 0;
      // We don't increment dataPoints again since it's already counted
    }
    console.log('Calculated speed averages by hour');
    
    // Calculate the final results
    const hourlyData = hourlyAverages.map((data, hour) => {
      if (data.dataPoints === 0) {
        return { hour, trafficCount: 0, avgSpeed: 0 };
      }
      return {
        hour,
        trafficCount: Math.round(data.trafficCount / data.dataPoints), // Divide by data points to get the average
        avgSpeed: Number((data.avgSpeed / data.dataPoints).toFixed(1))
      };
    });
    console.log('Calculated final results');
    
    // Filter hourlyAveragesByName to include only stations which are included in trafficCountSensors or in speedSensors
    const filteredHourlyAveragesByName = hourlyAveragesByName.filter(sensor => 
      trafficCountSensors.some(tc => tc.name === sensor.name) || 
      speedSensors.some(ss => ss.name === sensor.name)
    );
    console.log('Filtered hourly averages by name');

    // Build the enhanced response
    const response = {
      stationId,
      period: {
        start: startDate,
        end: endDate
      },
      hourlyAverages: hourlyData,
      sensorData: filteredHourlyAveragesByName
    };
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };
  } catch (error) {
    console.error('Error getting hourly average data:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'Failed to get hourly average data', error: String(error) })
    };
  }
}