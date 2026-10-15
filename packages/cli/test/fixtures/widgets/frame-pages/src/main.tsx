// A fixture widget with Frames: chart.html is in the package, meter.html isn't.
import { Frame, View } from "@cmd/widget-api";

export default function Main() {
  return (
    <View>
      <Frame src="chart.html" label="Chart" />
      <Frame src="meter.html" label="Meter" />
    </View>
  );
}
