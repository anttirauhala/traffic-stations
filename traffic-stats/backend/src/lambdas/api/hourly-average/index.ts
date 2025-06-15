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
 * Uses fast manual calculation with proper DST handling and caching
 */
const hourCache: { [timeString: string]: number } = {};
const dstCache: { [dateString: string]: boolean } = {}; // Cache DST calculations per date

const isDSTForDate = (year: number, month: number, day: number): boolean => {
  const dateKey = `${year}-${month}-${day}`;
  
  if (dstCache[dateKey] !== undefined) {
    return dstCache[dateKey];
  }
  
  let isDST = false;
  
  if (month > 2 && month < 9) {
    // April-September: always DST
    isDST = true;
  } else if (month === 2) {
    // March: check if on or after last Sunday
    const lastSunday = 31 - ((new Date(year, 2, 31).getDay() + 6) % 7);
    isDST = day >= lastSunday;
  } else if (month === 9) {
    // October: check if before last Sunday
    const lastSunday = 31 - ((new Date(year, 9, 31).getDay() + 6) % 7);
    isDST = day < lastSunday;
  }
  // November-February: always standard time (isDST = false)
  
  dstCache[dateKey] = isDST;
  return isDST;
};

const getHelsinkiHour = (utcTimeString: string): number => {
  // Check if we've already calculated this hour
  if (hourCache[utcTimeString] !== undefined) {
    return hourCache[utcTimeString];
  }

  // Create a date object from the UTC time string
  const date = new Date(utcTimeString);
  
  // Helsinki timezone: UTC+2 (EET) in winter, UTC+3 (EEST) in summer
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-11
  const day = date.getUTCDate();
  
  // Use cached DST calculation
  const isDST = isDSTForDate(year, month, day);
  
  // Add the Helsinki offset: +2 hours (EET) or +3 hours (EEST)
  const offsetHours = isDST ? 3 : 2;
  const helsinkiTime = new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
  
  // Store in cache and return the hour
  const hour = helsinkiTime.getUTCHours();
  hourCache[utcTimeString] = hour;
  return hour;
};

/**
 * API handler for getting hourly average traffic data for a specific station
 * based on data from the last month
 * Endpoint: GET /traffic/station/{stationId}/hourly-average
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // DEBUG-LOG-BEGIN: Remove these logs when everything is working
    console.log('DEBUG: Incoming event:', JSON.stringify(event, null, 2));
    console.log('DEBUG: Environment variables:', JSON.stringify(process.env, null, 2));
    // DEBUG-LOG-END
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
    // Using date range in compositeKey for efficient querying at the key level
    // DEBUG-LOG-BEGIN: Remove these logs and pagination logic when everything is working
    let items: SensorValue[] = [];
    let lastEvaluatedKey = undefined;
    let page = 0;
    
    // Use date range in KeyConditionExpression for more efficient querying
    const startDateKey = `${stationId}#${new Date(startDate).toISOString()}`;
    const endDateKey = `${stationId}#${new Date(endDate + 'T23:59:59.999Z').toISOString()}`;
    
    do {
      page++;
      const result = await docClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'stationId = :stationId AND compositeKey BETWEEN :startKey AND :endKey',
        ExpressionAttributeValues: {
          ':stationId': parseInt(stationId, 10),
          ':startKey': startDateKey,
          ':endKey': endDateKey
        },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      console.log(`DEBUG: Query page ${page}, items:`, result.Items?.length, 'LastEvaluatedKey:', result.LastEvaluatedKey);
      console.log(`DEBUG: Date range - Start: ${startDateKey}, End: ${endDateKey}`);
      if (result.Items && result.Items.length > 0) {
        console.log(`DEBUG: First item compositeKey:`, result.Items[0].compositeKey);
        console.log(`DEBUG: Last item compositeKey:`, result.Items[result.Items.length - 1].compositeKey);
      }
      if (result.Items) items = items.concat(result.Items as SensorValue[]);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    console.log('DEBUG: Total items fetched:', items.length);
    // DEBUG-LOG-END
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
      trafficDataPoints: 0,    // Separate counter for traffic count data points
      speedDataPoints: 0       // Separate counter for speed data points
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
      hourlyAverages[hour].trafficDataPoints += 1;
    }
    console.log('Calculated traffic count averages by hour');
    
    // Calculate speed averages by hour
    console.log(`DEBUG: Processing ${speedSensors.length} speed sensors`);
    let speedValueSum = 0;
    let speedCount = 0;
    
    for (const item of speedSensors) {
      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = getHelsinkiHour(timeString);
      
      hourlyAverages[hour].avgSpeed += item.value || 0;
      hourlyAverages[hour].speedDataPoints += 1;
      speedValueSum += item.value || 0;
      speedCount++;
      
      // Log some sample speed values
      if (speedCount <= 10) {
        console.log(`DEBUG: Speed sensor sample ${speedCount}: ${item.name}, value: ${item.value} ${item.unit}, hour: ${hour}`);
      }
    }
    console.log(`DEBUG: Speed calculation summary - Total sensors: ${speedCount}, Average raw speed: ${speedCount > 0 ? (speedValueSum / speedCount).toFixed(1) : 0} km/h`);
    console.log('Calculated speed averages by hour');
    
    // Calculate the final results
    console.log('DEBUG: Calculating final hourly averages...');
    const hourlyData = hourlyAverages.map((data, hour) => {
      // Calculate traffic count average
      const trafficCount = data.trafficDataPoints === 0 ? 0 : Math.round(data.trafficCount / data.trafficDataPoints);
      
      // Calculate speed average - use separate speed data points
      const avgSpeed = data.speedDataPoints === 0 ? 0 : Number((data.avgSpeed / data.speedDataPoints).toFixed(1));
      
      // Log some sample calculations
      if (hour < 3 || data.avgSpeed > 0) {
        console.log(`DEBUG: Hour ${hour}: traffic sum=${data.trafficCount.toFixed(1)}, traffic dataPoints=${data.trafficDataPoints}, speed sum=${data.avgSpeed.toFixed(1)}, speed dataPoints=${data.speedDataPoints}, final avg speed=${avgSpeed} km/h`);
      }
      
      return {
        hour,
        trafficCount,
        avgSpeed
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