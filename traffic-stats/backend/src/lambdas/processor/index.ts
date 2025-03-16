import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSEvent, SQSHandler, SQSBatchResponse } from 'aws-lambda';
import { TrafficDataSQSMessage } from '../../../../common/interfaces';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Lambda function that processes traffic data from SQS queue
 * and stores it in DynamoDB for later retrieval
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string; }[] = [];

  try {
    console.log(`Processing ${event.Records.length} messages`);
    
    const tableName = process.env.DYNAMODB_TABLE_NAME;
    if (!tableName) {
      throw new Error('DYNAMODB_TABLE_NAME environment variable is not defined');
    }
    
    // Process all SQS messages in the batch
    for (const record of event.Records) {
      try {
        const body: TrafficDataSQSMessage = JSON.parse(record.body);
        const { collected, trafficData } = body;
        
        console.log(`Processing traffic data collected at ${collected} with ${trafficData.length} stations`);
        
        // Count and log 60MIN sensors specifically
        let total60MinSensors = 0;
        trafficData.forEach(data => {
          const count = data.sensorValues.filter(sensor => sensor.name.includes('60MIN')).length;
          total60MinSensors += count;
        });
        console.log(`Processing ${total60MinSensors} sensor values with 60MIN in name`);
        
        // Debug log the first station's data structure
        if (trafficData.length > 0 && trafficData[0].sensorValues.length > 0) {
          console.log('Sample sensor value data structure:', 
                      JSON.stringify(trafficData[0].sensorValues[0], null, 2));
        }

        // Store each sensor value in DynamoDB
        let stored60MinCount = 0;
        for (const stationData of trafficData) {
          for (const sensorValue of stationData.sensorValues) {
            try {
              const is60Min = sensorValue.name.includes('60MIN');
              
              // Special logging for 60MIN sensors
              if (is60Min) {
                console.log(`Processing 60MIN sensor: ${sensorValue.name}, stationId: ${sensorValue.stationId}, id: ${sensorValue.id}`);
                console.log(`60MIN sensor fields:`, {
                  stationId: sensorValue.stationId,
                  timeWindowStart: sensorValue.timeWindowStart,
                  timeWindowEnd: sensorValue.timeWindowEnd,
                  measuredTime: sensorValue.measuredTime || collected,
                  value: sensorValue.value
                });
              }

              // Create a composite key to ensure uniqueness
              const compositeKey = `${sensorValue.stationId}#${sensorValue.measuredTime}#${sensorValue.name}`;

              // Create the item ensuring all fields are preserved
              const item = {
                ...sensorValue,
                compositeKey
              };

              // Log the item being stored in DynamoDB
              console.log('Storing item in DynamoDB:', JSON.stringify(item, null, 2));
              
              await docClient.send(new PutCommand({
                TableName: tableName,
                Item: item
              }));
              
              if (is60Min) {
                stored60MinCount++;
                console.log(`Successfully stored 60MIN sensor, running count: ${stored60MinCount}`);
              }
            } catch (sensorError) {
              const is60Min = sensorValue.name.includes('60MIN');
              if (is60Min) {
                console.error(`Error storing 60MIN sensor value (stationId: ${sensorValue.stationId}, id: ${sensorValue.id}):`, sensorError);
              } else {
                console.error(`Error storing sensor value (stationId: ${sensorValue.stationId}, id: ${sensorValue.id}):`, sensorError);
              }
              // Mark the entire message as failed if any sensor value fails
              if (!batchItemFailures.find(failure => failure.itemIdentifier === record.messageId)) {
                batchItemFailures.push({ itemIdentifier: record.messageId });
              }
            }
          }
        }
        
        console.log(`Successfully stored ${stored60MinCount} of ${total60MinSensors} 60MIN sensor values`);
      } catch (error) {
        console.error('Error processing record:', error);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    
    console.log(`Successfully processed ${event.Records.length - batchItemFailures.length} out of ${event.Records.length} messages`);
  } catch (error) {
    console.error('Error processing traffic data:', error);
    // If there's an overall error, mark all messages as failed so they can be reprocessed
    for (const record of event.Records) {
      if (!batchItemFailures.find(failure => failure.itemIdentifier === record.messageId)) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    // Don't throw the error, as we're handling it by marking messages as failed
  }

  return { batchItemFailures };
}