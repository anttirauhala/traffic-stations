import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { SensorValue } from '../../../../../common/interfaces';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * API handler for getting daily traffic data for a specific station
 * Endpoint: GET /traffic/station/{stationId}/daily?date=YYYY-MM-DD
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
    const date = event.queryStringParameters?.date || new Date().toISOString().split('T')[0]; // Default to today
    
    if (!stationId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Missing stationId parameter' })
      };
    }
    
    console.log(`Getting daily data for station ${stationId} on date ${date}`);
    
    const tableName = process.env.DYNAMODB_TABLE_NAME;
    if (!tableName) {
      throw new Error('DYNAMODB_TABLE_NAME environment variable is not defined');
    }
    
    // Query DynamoDB for all sensor values for this station and date using the GSI
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'MeasuredTimeIndex',
      KeyConditionExpression: 'measuredTime = :date AND stationId = :stationId',
      ExpressionAttributeValues: {
        ':stationId': parseInt(stationId, 10), // Convert to number to match the table schema
        ':date': date
      }
    }));
    
    console.log(`Found ${result.Items?.length || 0} records for station ${stationId} on date ${date}`);
    
    // Format the response
    const sensorValues: SensorValue[] = result.Items as SensorValue[] || [];
    const response = {
      stationId,
      date,
      sensorValues
    };
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };
  } catch (error) {
    console.error('Error getting daily data:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'Failed to get daily data', error: String(error) })
    };
  }
}