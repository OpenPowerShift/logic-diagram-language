export const EXAMPLES: Record<string, string> = {
  'Simple AND Gate': `// Simple AND gate
OUT = A AND B`,

  'Simple OR Gate': `// Simple OR gate
OUT = A OR B`,

  'NOT Gate': `// NOT gate
OUT = NOT A`,

  'Combined Logic (CBFPS)': `// Protection logic for CBFPS
CBFPS = AB AND DC OR (NOT DC AND GF)`,

  'Trip Logic': `// Trip Logic with OR and NOT
TRIP = OVERCURRENT OR (NOT EARTH_FAULT)

// Combined trip
MAIN_TRIP = TRIP AND MANUAL_TRIP`,

  'Three-Input AND': `// Three inputs into an AND gate
OUT = A AND B AND C`,

  'Triple OR': `// Three inputs into an OR gate
ALARM = TEMP OR PRESSURE OR FLOW`,

  'Nested NOT': `// Double negation
OUT = NOT NOT A`,

  'Complex Protection': `// Complex protection scheme
TRIP_1 = OVERCURRENT_A OR OVERCURRENT_B
TRIP_2 = EARTH_FAULT AND NOT BLOCK
MAIN_TRIP = TRIP_1 AND TRIP_2`,

  'Mixed Logic': `// Mixed AND/OR with negation
RESULT = (A AND B) OR (C AND NOT D)
OUTPUT = RESULT AND ENABLE`,

  'Interlocking Q01 Close': `// Interlocking Example for Collector Feeder Q01 (Close)

I1.Name = "CBQ 00 Open"
I1.Description = "(BI 3.1)"

I2.Name = "BB Not Earthed"
I2.Description = "(BI 3.24)"

I3.Name = "D/S Q01 Open"
I3.Description = "(BI 3.3)"

I4.Name = "E/S Q05 Open"
I4.Description = "(BI 3.5)"

I5.Name = "KF1 Release"
I5.Description = "(BI 3.15)"

I6.Name = "In Remote"
I6.Description = "(BI 3.11)"

I7.Name = "SCADA ON"
I7.Description = "(BI 3.23)"

I8.Name = "DNP Close Command"
I8.Description = "(via RTU)"

I9.Name = "In Local"
I9.Description = "(BI 3.12)"

I10.Name = "Close Switch"
I10.Description = "(BI 3.20)"

O1 = (I1 AND I2) AND (I3 AND I4 AND NOT I5) AND ((I6 AND I7 AND I8) OR (I9 AND I10))

O1.Name = "Output"
O1.Description = "(BO 3.2)"`,

  'Inversion Bubbles': `// Inversion Bubbles: NOT rendered as bubbles on gate inputs/outputs
OPTION INVERSION = BUBBLES

I1.Name = "Start Permitted"
I1.Description = "(BI 1.1)"
I2.Name = "Stop Condition"
I2.Description = "(BI 1.2)"
I3.Name = "Reset"
I3.Description = "(BI 1.3)"

O1 = I1 AND NOT I2 AND I3
O2 = NOT (I1 AND I3)
O3 = NOT I2
O4 = NOT NOT I3

O1.Name = "Run"
O1.Description = "(BO 1.1)"
O2.Name = "NAND Result"
O2.Description = "(BO 1.2)"
O3.Name = "Inverted Stop"
O3.Description = "(BO 1.3)"
O4.Name = "Pass-Through"
O4.Description = "(BO 1.4)"`,

  'Input Bars': `// Input Bars: multi-input gates stay at 2-input size
OPTION GATE_INPUT_STYLE = BARS

I1.Name = "Start"
I2.Name = "Stop"
I3.Name = "Reset"
I4.Name = "Enable"
I5.Name = "Supervision"

O1 = I1 AND I2 AND I3 AND I4 AND I5
O1.Name = "Output"`,

  'Square Ports': `// Square port markers
OPTION PORT_STYLE = SQUARE

A.Name = "Signal A"
B.Name = "Signal B"
O1 = A AND B
O1.Name = "Result"`,

  'Combined Options': `// Combined options: bubbles + bars + square ports
OPTION INVERSION = BUBBLES
OPTION GATE_INPUT_STYLE = BARS
OPTION PORT_STYLE = SQUARE

I1.Name = "Start"
I2.Name = "Stop"
I3.Name = "Reset"
I4.Name = "Enable"
I5.Name = "Supervision"
I6.Name = "Override"

O1 = (I1 AND NOT I2) AND (I3 AND I4 AND I5 AND I6)
O1.Name = "Master Trip"
O1.Description = "(BO 1.1)"`,

  'Overcurrent Protection': `// Overcurrent protection with math labels
I1.Name = "$I_a$"
I1.Description = "Phase A current"

I2.Name = "$I_b$"
I2.Description = "Phase B current"

I3.Name = "$I_c$"
I3.Description = "Phase C current"

I4.Name = "$I_{set}$"
I4.Description = "Setting $= 5.0 \\$ A$"

O1.Name = "$I > I_{set}$"
O1.Description = "Overcurrent trip"

O2.Name = "$I_a + I_b + I_c$"
O2.Description = "Residual current"

O1 = I1 AND I4
O2 = I1 OR I2 OR I3`,

  'Differential Protection': `// Differential protection: $I_{diff} = I_{in} - I_{out}$

I1.Name = "$I_{in}$"
I1.Description = "CT primary current"

I2.Name = "$I_{out}$"
I2.Description = "CT secondary current"

I3.Name = "Block"
I3.Description = "Blocking signal"

O1.Name = "$I_{diff} > I_{bias}$"
O1.Description = "Differential trip"

O2.Name = "Restricted Earth Fault"
O2.Description = "$I_0 > I_{0\\_set}$"

O1 = (I1 AND NOT I2) AND NOT I3
O2 = NOT I3`,

  'Boolean Algebra': `// Boolean algebra with math notation
A.Name = "$A$"
A.Description = "Input A"

B.Name = "$B$"
B.Description = "Input B"

C.Name = "$C$"
C.Description = "Input C"

O1.Name = "$A \\cdot B$"
O1.Description = "Logical AND"

O2.Name = "$A + B$"
O2.Description = "Logical OR"

O3.Name = "$\\overline{A}$"
O3.Description = "Logical NOT"

O4.Name = "$\\overline{A \\cdot B}$"
O4.Description = "NAND: $\\overline{AB}$"

O1 = A AND B
O2 = A OR B
O3 = NOT A
O4 = NOT (A AND B)`,

  'Motor Control Circuit': `// Motor starting circuit with math notation

I1.Name = "Start PB"
I1.Description = "$NO\\ contact$"

I2.Name = "Stop PB"
I2.Description = "$NC\\ contact$"

I3.Name = "OL Trip"
I3.Description = "$I^2 > I_{rated}^2$"

I4.Name = "Thermal"
I4.Description = "$\\Theta > \\Theta_{trip}$"

I5.Name = "$I_s$"
I5.Description = "Start current"

O1.Name = "Contactor"
O1.Description = "$K_1$"

O2.Name = "Trip"
O2.Description = "$\\Delta I > \\Delta I_{set}$"

OPTION INVERSION = BUBBLES

O1 = I1 AND NOT I2 AND NOT I3 AND NOT I4
O2 = I3 OR I4 OR NOT I5`,
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLES);