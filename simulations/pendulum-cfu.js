/* Authored once; lesson references and assessment filtering share these questions. */
(function () {
  'use strict';
  SimLib.PendulumCFU = SimLib.CFU.bank({
    id: 'pendulum-period', version: 1,
    questions: [
      { id: 'length', use: 'both', type: 'single',
        prompt: 'For an ideal small-angle pendulum, increasing length while keeping gravity fixed makes the period…',
        choices: [{ id: 'increase', label: 'Increase' }, { id: 'same', label: 'Stay the same' }, { id: 'decrease', label: 'Decrease' }],
        correct: ['increase'], explanation: 'T = 2π√(L/g). A longer pendulum takes longer to complete one full back-and-forth swing.' },
      { id: 'mass', use: 'both', type: 'single',
        prompt: 'With no drag, at small angles, doubling the bob mass while keeping length and gravity fixed makes the period…',
        choices: [{ id: 'double', label: 'Double' }, { id: 'same', label: 'Stay the same' }, { id: 'half', label: 'Halve' }],
        correct: ['same'], explanation: 'Mass cancels from the ideal pendulum equation. It is absent from T = 2π√(L/g); this claim assumes no drag.' },
      { id: 'gravity', use: 'both', type: 'single',
        prompt: 'The same ideal small-angle pendulum is moved to a place with weaker gravity. Its period will…',
        choices: [{ id: 'shorter', label: 'Be shorter' }, { id: 'longer', label: 'Be longer' }, { id: 'same', label: 'Be unchanged' }],
        correct: ['longer'], explanation: 'T is proportional to 1/√g. Weaker gravity gives a longer period, with length held fixed.' },
      { id: 'scaling', use: 'assessment', type: 'single',
        prompt: 'If length is multiplied by four at fixed gravity, what happens to the ideal small-angle period?',
        choices: [{ id: 'four', label: 'It is multiplied by four' }, { id: 'two', label: 'It is multiplied by two' }, { id: 'half', label: 'It is divided by two' }],
        correct: ['two'], explanation: 'The square root of four is two. Period scales with √L, not directly with L.' },
      { id: 'dependencies', use: 'assessment', type: 'multi',
        prompt: 'Which changes increase the period of an ideal small-angle pendulum? Hold other variables fixed for each change.',
        choices: [{ id: 'length', label: 'Increase length' }, { id: 'mass', label: 'Increase mass' }, { id: 'gravity', label: 'Decrease gravity' }, { id: 'angle', label: 'Increase amplitude from 5° to 10° (small-angle approximation)' }],
        correct: ['length', 'gravity'], explanation: 'In the small-angle approximation, only L and g set the period: increasing L or decreasing g increases T. Mass and small amplitude do not appear in this approximation.' },
      { id: 'limits', use: 'lesson', type: 'multi',
        prompt: 'Which assumptions support using T = 2π√(L/g)?',
        choices: [{ id: 'small', label: 'Small swing angles' }, { id: 'ideal', label: 'Negligible drag' }, { id: 'heavy', label: 'A very heavy bob is required' }],
        correct: ['small', 'ideal'], explanation: 'The formula describes an ideal, small-angle pendulum. At large angles the period increases with amplitude; a heavy bob is not a requirement.' },
    ],
  });
})();
