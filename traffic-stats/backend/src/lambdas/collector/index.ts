import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import axios from 'axios';
import { Handler } from 'aws-lambda';
import { Station, TrafficData, TrafficDataSQSMessage } from '../../../../common/interfaces';
import { getTampereStations } from '../../../../common/common';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });

/**
 * Lambda function that collects traffic data from Digitraffic API
 * and sends it to an SQS queue for further processing
 */
export const handler: Handler = async (event) => {
  try {
    console.log('Starting to fetch traffic data from Digitraffic');
    
    // Fetch stations from Digitraffic API
    const tampereStations = await getTampereStations();
    
    console.log(`Found ${tampereStations.length} stations near Tampere`);
    console.log('Station IDs:', tampereStations.map(station => station.id).join(', '));
    
    // Fetch traffic data for each station
    const trafficDataPromises = tampereStations.map(async station => {
      console.log(`Fetching data for station ${station.id}: ${station.name}`);
      const response = await axios.get(`https://tie.digitraffic.fi/api/tms/v1/stations/${station.id}/data`);
      
      // Log any 60MIN sensor values found in the response
      const data = response.data as TrafficData;
      const sixtyMinSensors = data.sensorValues.filter(sensor => sensor.name.includes('60MIN'));
      if (sixtyMinSensors.length > 0) {
        console.log(`Found ${sixtyMinSensors.length} sensors with 60MIN in name for station ${station.id}`);
        console.log('Sample 60MIN sensor:', JSON.stringify(sixtyMinSensors[0], null, 2));
      }
      
      // Filter sensorValues to include only those with timeWindowStart
      data.sensorValues = data.sensorValues.filter(sensor => sensor.timeWindowStart);
      
      return data;
    });
    
    const trafficData = await Promise.all(trafficDataPromises);
    console.log(`Successfully fetched data for ${trafficData.length} stations`);
    
    // Count total 60MIN sensor values across all stations
    let total60MinSensors = 0;
    trafficData.forEach(data => {
      const count = data.sensorValues.filter(sensor => sensor.name.includes('60MIN')).length;
      total60MinSensors += count;
    });
    console.log(`Total 60MIN sensor values found: ${total60MinSensors}`);
    
    // Send each station's data to the SQS queue for further processing
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error('SQS_QUEUE_URL environment variable is not defined');
    }
    
    // Add timestamp for when the data was collected
    const timestamp = new Date().toISOString();
    console.log(`Data collection timestamp: ${timestamp}`);
    
    const dataWithTimestamp: TrafficDataSQSMessage = {
      collected: timestamp,
      trafficData: trafficData
    };
    
    // Log some basic stats about the data
    let totalSensorValues = 0;
    trafficData.forEach(data => {
      totalSensorValues += data.sensorValues.length;
    });
    console.log(`Total sensor values to be sent: ${totalSensorValues}`);
    
    // Check if data has required time fields
    if (trafficData.length > 0 && trafficData[0].sensorValues.length > 0) {
      const sampleSensor = trafficData[0].sensorValues[0];
      console.log('Sample sensor value fields:', {
        hasTimeWindowStart: !!sampleSensor.timeWindowStart,
        hasTimeWindowEnd: !!sampleSensor.timeWindowEnd,
        hasMeasuredTime: !!sampleSensor.measuredTime,
        stationId: sampleSensor.stationId,
        name: sampleSensor.name,
        value: sampleSensor.value,
        unit: sampleSensor.unit
      });
    }
    
    console.log(`Sending data to SQS queue: ${queueUrl}`);
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(dataWithTimestamp),
    }));
    
    console.log('Data successfully sent to SQS queue');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Traffic data has been successfully collected and sent to SQS queue',
        stationsCount: trafficData.length
      })
    };
  } catch (error) {
    console.error('Error collecting traffic data:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to collect traffic data', error: String(error) })
    };
  }
}