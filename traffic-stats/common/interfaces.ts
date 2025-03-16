export interface Station {
    id: string;
    name: string;
    lat: number;
    lon: number;
    fullName?: string;
    description?: string;
}

export interface SensorValue {
    id: number;
    stationId: number;
    name: string;
    shortName: string;
    timeWindowStart: Date;
    timeWindowEnd: Date;
    measuredTime: Date;
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
