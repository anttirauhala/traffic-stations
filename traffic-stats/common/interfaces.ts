export interface Station {
    id: string;
    name: string;
    lat: number;
    lon: number;
    fullName?: string;
    description?: string;
    collectionStatus?: undefined,
}

export interface SensorValue {
    id: number;
    stationId: number;
    name: string;
    shortName: string;
    timeWindowStart: string;
    timeWindowEnd: string;
    measuredTime: string;
    value: number;
    unit: string;
}

export interface TrafficData {
    id: number;
    tmsNumber: number;
    dataUpdatedTime: string;
    sensorValues: SensorValue[];
}

export interface TrafficDataSQSMessage {
    collected: string;
    trafficData: TrafficData[]
}
