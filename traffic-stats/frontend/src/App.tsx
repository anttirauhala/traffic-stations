import * as React from 'react';
import { useState, useEffect } from 'react';
import { getTampereStations } from '../../common/common';
import StationSelector from './StationSelector';
import './App.css';

interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const App: React.FC = () => {
  const [stations, setStations] = useState<Station[]>([]);

  useEffect(() => {
    const fetchStations = async () => {
      try {
        const tampereStations = await getTampereStations();
        setStations(tampereStations);
      } catch (error) {
        console.error('Error fetching stations:', error);
      }
    };
    fetchStations();
  }, []);

  return (
    <div className="App">
      <h1>Traffic Stats</h1>
      <StationSelector stations={stations} />
    </div>
  );
};

export default App;
