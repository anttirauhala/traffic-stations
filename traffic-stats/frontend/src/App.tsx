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
  fullName?: string;
  description?: string;
  collectionStatus?: string;
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
      <footer style={{ fontSize: 'small', textAlign: 'center', marginTop: '20px' }}>
        <p>Liikennetietojen lähde Fintraffic / <a href="https://digitraffic.fi">digitraffic.fi</a>, lisenssi <a href="https://creativecommons.org/licenses/by/4.0/">CC 4.0 BY</a></p>
        <p>Esitettävät tiedot on jalostettu Fintrafficin / Digitrafficin tiedoista laskemalla ja tietojen oikeellisuutta ei taata.</p>
        <p>Kaikki oikeudet pidätetään. Tämä sivusto ei ole Fintrafficin virallinen sivusto.</p>
      </footer>
    </div>
  );
};

export default App;
