import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { SensorValue } from '../../../../../common/interfaces';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

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
    
    for (const item of items) {
      if (!item.value || item.value === 0) continue;
      
      // Use timeWindowStart if available, otherwise fall back to measuredTime
      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = new Date(timeString).getHours();
      
      // Initialize structures if they don't exist
      if (!groupedByNameAndHour[item.name]) {
        groupedByNameAndHour[item.name] = {};
      }
      if (!groupedByNameAndHour[item.name][hour]) {
        groupedByNameAndHour[item.name][hour] = { sum: 0, count: 0 };
      }
      
      groupedByNameAndHour[item.name][hour].sum += item.value;
      groupedByNameAndHour[item.name][hour].count++;
    }
    
    // Convert grouped data to the response format
    const hourlyAveragesByName: { 
      name: string;
      unit: string;
      hourlyData: { hour: number; value: number }[]
    }[] = [];
    
    // Process each sensor type
    for (const [name, hourData] of Object.entries(groupedByNameAndHour)) {
      // Find a sample item to get the unit
      const sampleItem = items.find(item => item.name === name);
      
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
        unit: sampleItem?.unit || '',
        hourlyData
      });
    }
    
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
      const hour = new Date(timeString).getHours();
      
      hourlyAverages[hour].trafficCount += item.value || 0;
      hourlyAverages[hour].dataPoints += 1;
    }
    
    // Calculate speed averages by hour
    for (const item of speedSensors) {
      const timeString = item.timeWindowStart || item.measuredTime;
      const hour = new Date(timeString).getHours();
      
      hourlyAverages[hour].avgSpeed += item.value || 0;
      // We don't increment dataPoints again since it's already counted
    }
    
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
    
    // Filter hourlyAveragesByName to include only stations which are included in trafficCountSensors or in speedSensors
    const filteredHourlyAveragesByName = hourlyAveragesByName.filter(sensor => 
      trafficCountSensors.some(tc => tc.name === sensor.name) || 
      speedSensors.some(ss => ss.name === sensor.name)
    );

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